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

/**
 * Mark the cached server as dead so the next `getServer()` call spawns a fresh
 * one. Used after we see `fetch failed` / `ECONNRESET` style errors — which
 * almost always mean the child process exited and any subsequent call against
 * that cached handle will fail the same way.
 */
function invalidateServer(reason: string): void {
  if (!serverPromise) return;
  const dead = serverPromise;
  serverPromise = null;
  authedProviders.clear();
  dead.then(h => { try { h.close(); } catch { /* ignore */ } }, () => { /* ignore */ });
  // eslint-disable-next-line no-console
  // (silent — callers log the original error and we respawn on next getServer)
  void reason;
}

/**
 * Heuristic: treat network-layer errors as "server dead, respawn". We match on
 * the canonical undici message (`fetch failed`) plus common socket errors.
 */
function isFetchFailure(err: unknown): boolean {
  const s = String((err as { message?: unknown } | null)?.message ?? err ?? '');
  return /fetch failed|ECONNRESET|ECONNREFUSED|socket hang up|EPIPE/i.test(s);
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

  // Setup is retryable — if the cached opencode server died, a fetch-layer
  // failure here (getServer / auth / session.create / subscribe) is almost
  // always transient: we invalidate the handle so the next call respawns,
  // and try once more before giving up.
  let setup: { client: OpencodeClient; sessionID: string; eventStream: AsyncIterable<unknown> } | null = null;
  {
    let lastErr: unknown = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const server = await getServer();
        const c = server.client;
        await ensureAuth(c, providerID, apiKey);
        const created = await c.session.create({ query: { directory: cwd }, body: {} });
        const id = (created.data as { id?: string } | undefined)?.id;
        if (!id) throw new Error('session.create returned no id');
        const sub = await c.event.subscribe({ query: { directory: cwd }, parseAs: 'stream' }) as unknown as { stream: AsyncIterable<unknown> };
        setup = { client: c, sessionID: id, eventStream: sub.stream };
        break;
      } catch (err) {
        lastErr = err;
        if (attempt === 0 && isFetchFailure(err)) {
          log(`[event] setup fetch failed — respawning opencode server: ${String(err)}`);
          invalidateServer('fetch failed during setup');
          continue;
        }
        break;
      }
    }
    if (!setup) {
      log(`[event] setup failed: ${String(lastErr)}`);
      yield { type: 'error', text: `opencode setup failed: ${String(lastErr)}` };
      return;
    }
  }
  const { client, sessionID, eventStream } = setup;

  // Fire the prompt. We don't `await` it up-front because we want to drain
  // the event stream in parallel. But we *do* track its resolution — when
  // `session.prompt` returns, the HTTP call is done and the assistant has
  // finished responding. That's our backstop in case `session.idle` never
  // arrives (observed in practice with some openrouter models).
  type PromptResult = { error: unknown } | undefined;
  const promptPromise: Promise<PromptResult> = client.session.prompt({
    path: { id: sessionID },
    query: { directory: cwd },
    body: {
      model: { providerID, modelID },
      parts: [{ type: 'text', text: prompt }],
    },
  }).then(
    () => undefined,
    (err) => { log(`[event] prompt error: ${String(err)}`); return { error: err }; },
  );

  let aborted = false;
  const onAbort = () => { aborted = true; };
  signal?.addEventListener('abort', onAbort);

  // Buffer text parts by id so we only yield deltas (opencode emits the full
  // running text each update; we subtract the last snapshot to produce a delta).
  const textSnapshots = new Map<string, string>();

  // `processEvent` classifies a single raw event and returns (a) chunks to
  // stream upstream, and (b) an optional stop signal. We can't yield from
  // inside a nested function, so we collect the yields and emit them in the
  // outer loop. Returns null for events we ignore.
  type Processed = {
    chunks: string[];
    stop?: 'idle' | 'error';
    errorText?: string;
  };
  const processEvent = (raw: unknown): Processed => {
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
    const out: Processed = { chunks: [] };

    if (evt.type === 'message.part.updated' && relevant && evt.properties?.part) {
      const part = evt.properties.part;
      if (part.type === 'reasoning' && part.id && typeof part.text === 'string') {
        const prev = textSnapshots.get(part.id) ?? '';
        const delta = part.text.slice(prev.length);
        textSnapshots.set(part.id, part.text);
        if (delta) {
          log(`[reasoning] ${delta}`);
          out.chunks.push(delta);
        }
      } else if (part.type === 'text' && part.id && typeof part.text === 'string') {
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
      out.stop = 'error';
      out.errorText = msg;
    } else if (evt.type === 'session.idle' && relevant) {
      log('[event] session.idle');
      out.stop = 'idle';
    }
    return out;
  };

  // Race events against prompt-done so we can't hang if session.idle never
  // fires. Pull events through a manual iterator so we can use Promise.race.
  const iter = (eventStream as AsyncIterable<unknown>)[Symbol.asyncIterator]();
  const promptDoneSentinel = Symbol('prompt-done');
  type Next = IteratorResult<unknown> | typeof promptDoneSentinel;

  try {
    while (true) {
      if (aborted) {
        log('[event] aborted');
        yield { type: 'skipped' };
        return;
      }

      const next = (await Promise.race([
        iter.next(),
        promptPromise.then(() => promptDoneSentinel),
      ])) as Next;

      if (next === promptDoneSentinel) {
        // Prompt HTTP call finished. Peek at the result: if it errored, skip
        // the drain and let the post-loop error handler surface it; if it
        // succeeded, drain the stream briefly to pick up any final parts
        // buffered just before session.idle.
        const peek = await promptPromise;
        if (peek && typeof peek === 'object' && 'error' in peek) {
          log(`[event] prompt settled with error: ${String(peek.error)}`);
          break;
        }
        log('[event] prompt settled — draining tail events');
        const drainDeadline = Date.now() + 500;
        while (Date.now() < drainDeadline) {
          const remaining = drainDeadline - Date.now();
          if (remaining <= 0) break;
          const tail = await Promise.race([
            iter.next(),
            new Promise<null>(r => setTimeout(() => r(null), remaining)),
          ]);
          if (tail === null) break;
          if (tail.done) break;
          const p = processEvent(tail.value);
          for (const c of p.chunks) yield { type: 'chunk', text: c };
          if (p.stop) break;
        }
        break;
      }

      if (next.done) {
        log('[event] event stream ended');
        break;
      }

      const p = processEvent(next.value);
      for (const c of p.chunks) yield { type: 'chunk', text: c };
      if (p.stop === 'error') {
        yield { type: 'error', text: p.errorText ?? 'unknown session error' };
        return;
      }
      if (p.stop === 'idle') break;
    }
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }

  const res = await promptPromise;
  if (res && typeof res === 'object' && 'error' in res) {
    // If the prompt itself died at the fetch layer, the server handle is
    // almost certainly dead too — invalidate so the next file respawns.
    if (isFetchFailure((res as { error: unknown }).error)) {
      invalidateServer('fetch failed during prompt');
    }
    yield { type: 'error', text: String((res as { error: unknown }).error) };
    return;
  }

  yield { type: 'done', code: 0 };
}
