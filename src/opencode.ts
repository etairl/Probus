// Thin wrapper around @opencode-ai/sdk that gives us a stream-of-events
// interface compatible with the rest of the scanner.
//
// Responsibilities:
//   - Boot one shared opencode server per process (lazy + reused across agents)
//   - Ensure the opencode binary is discoverable (prepend node_modules/.bin / opencode-ai/bin to PATH)
//   - Authenticate a provider once, on demand
//   - Run a one-shot prompt and stream text chunks / tool calls / completion

import { createOpencode, type OpencodeClient } from '@opencode-ai/sdk';
import { createRequire } from 'node:module';
import path from 'node:path';
import net from 'node:net';
import { appendFileSync } from 'node:fs';

export type OpencodeAgentEvent =
  | { type: 'chunk'; text: string }
  | { type: 'done'; code: number }
  | { type: 'skipped' }
  | { type: 'error'; text: string };

interface ServerHandle {
  client: OpencodeClient;
  close(): void;
}

let serverPromise: Promise<ServerHandle> | null = null;
const authedProviders = new Set<string>();

/** Pick a free TCP port on 127.0.0.1 by asking the OS. */
function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      if (addr && typeof addr === 'object') {
        const port = addr.port;
        srv.close(() => resolve(port));
      } else {
        reject(new Error('Failed to pick a free port'));
      }
    });
  });
}

/**
 * Prepend the directory containing opencode-ai's binary to PATH so cross-spawn
 * finds it even when probus is installed globally (transitive deps aren't
 * on PATH by default).
 */
function ensureOpencodeOnPath(): void {
  try {
    const req = createRequire(import.meta.url);
    const pkgJson = req.resolve('opencode-ai/package.json');
    const binDir = path.join(path.dirname(pkgJson), 'bin');
    const sep = path.delimiter;
    const parts = (process.env.PATH ?? '').split(sep);
    if (!parts.includes(binDir)) {
      process.env.PATH = binDir + sep + (process.env.PATH ?? '');
    }
  } catch {
    // If opencode-ai isn't resolvable we'll fall back to whatever is on PATH;
    // createOpencode will surface the spawn error.
  }
}

async function getServer(): Promise<ServerHandle> {
  if (!serverPromise) {
    ensureOpencodeOnPath();
    serverPromise = (async () => {
      const port = await getFreePort();
      const { client, server } = await createOpencode({ port, timeout: 20_000 });
      return {
        client,
        close: () => server.close(),
      };
    })();
  }
  return serverPromise;
}

/** Shut down the shared opencode server (called on process exit). */
export async function shutdownOpencode(): Promise<void> {
  if (!serverPromise) return;
  try {
    const { close } = await serverPromise;
    close();
  } catch { /* ignore */ }
  serverPromise = null;
  authedProviders.clear();
}

async function ensureAuth(client: OpencodeClient, providerID: string, key: string): Promise<void> {
  if (authedProviders.has(providerID)) return;
  await client.auth.set({
    path: { id: providerID },
    body: { type: 'api', key },
  });
  authedProviders.add(providerID);
}

/**
 * Runs a single prompt against opencode and streams the response back.
 *
 * `modelSlug` is `<providerID>/<modelID>`, e.g. `openai/gpt-5.4`.
 * `apiKey` is the credential for that provider (will be auth.set'd if not yet).
 */
export async function* runOpencodeAgent(opts: {
  prompt: string;
  cwd: string;
  providerID: string;
  modelID: string;
  apiKey: string;
  signal?: AbortSignal;
  logFile?: string;
  stageLabel?: string;
}): AsyncGenerator<OpencodeAgentEvent> {
  const { prompt, cwd, providerID, modelID, apiKey, signal, logFile, stageLabel } = opts;

  const log = (line: string) => {
    if (!logFile) return;
    try { appendFileSync(logFile, line.endsWith('\n') ? line : line + '\n'); } catch { /* ignore */ }
  };

  log(`\n===== ${new Date().toISOString()} [${stageLabel ?? 'agent'}] model=${providerID}/${modelID} =====`);
  log(`--- prompt ---\n${prompt}\n--- end prompt ---`);

  let server: ServerHandle;
  try {
    server = await getServer();
  } catch (err) {
    log(`[event] failed to start opencode server: ${String(err)}`);
    yield { type: 'error', text: `opencode server failed to start: ${String(err)}` };
    return;
  }
  const { client } = server;

  try {
    await ensureAuth(client, providerID, apiKey);
  } catch (err) {
    log(`[event] auth failed: ${String(err)}`);
    yield { type: 'error', text: `auth failed: ${String(err)}` };
    return;
  }

  // One session per agent call so cwd / context are isolated.
  let sessionID: string;
  try {
    const created = await client.session.create({ query: { directory: cwd }, body: {} });
    const id = (created.data as { id?: string } | undefined)?.id;
    if (!id) throw new Error(`session.create returned no id`);
    sessionID = id;
  } catch (err) {
    log(`[event] session.create failed: ${String(err)}`);
    yield { type: 'error', text: `session.create failed: ${String(err)}` };
    return;
  }

  // Subscribe to events filtered to our session before kicking off the prompt.
  let eventStream: AsyncIterable<unknown>;
  try {
    const sub = await client.event.subscribe({ query: { directory: cwd }, parseAs: 'stream' }) as unknown as { stream: AsyncIterable<unknown> };
    eventStream = sub.stream;
  } catch (err) {
    log(`[event] subscribe failed: ${String(err)}`);
    yield { type: 'error', text: `event subscribe failed: ${String(err)}` };
    return;
  }

  // Fire the prompt (don't await — we consume events until idle).
  const promptPromise = client.session.prompt({
    path: { id: sessionID },
    query: { directory: cwd },
    body: {
      model: { providerID, modelID },
      parts: [{ type: 'text', text: prompt }],
    },
  }).catch((err) => {
    log(`[event] prompt error: ${String(err)}`);
    return { error: err };
  });

  let aborted = false;
  const onAbort = () => { aborted = true; };
  signal?.addEventListener('abort', onAbort);

  // Buffer text parts by id so we only yield deltas (opencode emits the full
  // running text each update; we subtract the last snapshot to produce a delta).
  const textSnapshots = new Map<string, string>();

  try {
    for await (const raw of eventStream) {
      if (aborted) {
        log('[event] aborted');
        yield { type: 'skipped' };
        return;
      }

      const evt = raw as {
        type?: string;
        properties?: {
          part?: { id?: string; type?: string; text?: string; tool?: string; sessionID?: string };
          info?: { id?: string; error?: unknown };
          sessionID?: string;
          delta?: string;
        };
      };

      const partSession = evt.properties?.part?.sessionID;
      const infoSession = evt.properties?.sessionID;
      const relevant = partSession === sessionID || infoSession === sessionID;

      if (evt.type === 'message.part.updated' && relevant && evt.properties?.part) {
        const part = evt.properties.part;
        // Opencode streams `text` (final assistant output — usually structured
        // JSON/XML whose tail line is junk like `</output>`) and `reasoning`
        // (chain-of-thought). We only surface `reasoning` to the UI so the
        // "last line" thinking display isn't polluted by closing tags. `text`
        // content still lands on disk via tool calls that the agent makes.
        if (part.type === 'reasoning' && part.id && typeof part.text === 'string') {
          const prev = textSnapshots.get(part.id) ?? '';
          const delta = part.text.slice(prev.length);
          textSnapshots.set(part.id, part.text);
          if (delta) {
            log(`[reasoning] ${delta}`);
            yield { type: 'chunk', text: delta };
          }
        } else if (part.type === 'text' && part.id && typeof part.text === 'string') {
          // Log-only, don't stream to UI.
          const prev = textSnapshots.get(part.id) ?? '';
          const delta = part.text.slice(prev.length);
          textSnapshots.set(part.id, part.text);
          if (delta) log(`[text] ${delta}`);
        } else if (part.type === 'tool' && part.tool) {
          log(`[tool_use] ${part.tool}`);
        }
      } else if (evt.type === 'session.error' && relevant) {
        const msg = String((evt.properties?.info as { error?: unknown } | undefined)?.error ?? 'unknown session error');
        log(`[event] session.error ${msg}`);
        yield { type: 'error', text: msg };
        return;
      } else if (evt.type === 'session.idle' && relevant) {
        log('[event] session.idle');
        break;
      }
    }
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }

  const res = await promptPromise;
  if (res && typeof res === 'object' && 'error' in res) {
    yield { type: 'error', text: String((res as { error: unknown }).error) };
    return;
  }

  yield { type: 'done', code: 0 };
}
