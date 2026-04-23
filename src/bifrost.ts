// Bifrost is an Anthropic-compatible HTTP gateway that routes `/v1/messages`
// requests to OpenAI (and other providers). We spawn it as a subprocess when
// the user picks `--provider openai`, so we can keep using the Claude Agent
// SDK (which only speaks the Anthropic wire protocol) with OpenAI models.
//
// The bifrost npm package ships a launcher script that downloads a Go binary
// on first run and execs it with the remaining CLI args. We pass `-port N`
// and wait until the port accepts TCP connections before handing off.

import { spawn, type ChildProcess } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

interface BifrostHandle {
  baseURL: string;
  close(): void;
}

let bifrostPromise: Promise<BifrostHandle> | null = null;

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      if (addr && typeof addr === 'object') {
        const p = addr.port;
        srv.close(() => resolve(p));
      } else {
        srv.close(() => reject(new Error('no port')));
      }
    });
  });
}

function waitForPort(port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tryOnce = () => {
      const sock = net.createConnection({ host: '127.0.0.1', port });
      sock.once('connect', () => { sock.destroy(); resolve(); });
      sock.once('error', () => {
        sock.destroy();
        if (Date.now() > deadline) reject(new Error(`bifrost did not open port ${port} within ${timeoutMs}ms`));
        else setTimeout(tryOnce, 150);
      });
    };
    tryOnce();
  });
}

function resolveBifrostLauncher(): string {
  // Prefer the package's own bin.js so we don't depend on PATH lookup.
  try {
    const require_ = createRequire(import.meta.url);
    const pkgPath = require_.resolve('@maximhq/bifrost/package.json');
    return path.join(path.dirname(pkgPath), 'bin.js');
  } catch {
    // Fall back to a plain module path relative to this file.
    const here = path.dirname(fileURLToPath(import.meta.url));
    return path.resolve(here, '..', 'node_modules', '@maximhq', 'bifrost', 'bin.js');
  }
}

export async function ensureBifrost(openaiApiKey: string): Promise<string> {
  if (bifrostPromise) {
    const h = await bifrostPromise;
    return h.baseURL;
  }

  bifrostPromise = (async () => {
    const port = await getFreePort();
    const launcher = resolveBifrostLauncher();
    const child: ChildProcess = spawn(
      process.execPath,
      [launcher, '-port', String(port)],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          OPENAI_API_KEY: openaiApiKey,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );

    // Keep the child from surfacing noise into our Ink UI. We still want to
    // observe exits in case it crashes.
    child.stdout?.resume();
    child.stderr?.resume();

    const exited = new Promise<never>((_, reject) => {
      child.once('exit', code => reject(new Error(`bifrost exited early with code ${code}`)));
      child.once('error', reject);
    });

    try {
      await Promise.race([waitForPort(port, 60_000), exited]);
    } catch (err) {
      try { child.kill('SIGTERM'); } catch { /* ignore */ }
      throw err;
    }

    // Bifrost mounts the Anthropic-compatible Messages API at
    // `/anthropic/v1/messages`. The Anthropic SDK appends `/v1/messages` to
    // whatever baseURL we give it, so we include the `/anthropic` prefix here
    // to land on the right route (otherwise we get a 405 on `/v1/messages`).
    return {
      baseURL: `http://127.0.0.1:${port}/anthropic`,
      close: () => { try { child.kill('SIGTERM'); } catch { /* ignore */ } },
    };
  })().catch(err => {
    bifrostPromise = null;
    throw err;
  });

  const h = await bifrostPromise;
  return h.baseURL;
}

export async function shutdownBifrost(): Promise<void> {
  const p = bifrostPromise;
  bifrostPromise = null;
  if (!p) return;
  try {
    const h = await p;
    h.close();
  } catch { /* ignore */ }
}
