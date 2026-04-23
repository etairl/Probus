import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// Resolved lazily so tests can override HOME before calling.
function envDir(): string {
  return path.join(os.homedir(), '.probus');
}
function envFile(): string {
  return path.join(envDir(), '.env');
}

/** Directory that holds probus config (lazy — prefer {@link getEnvDir}). */
export const ENV_DIR: string = envDir();
/** Path to the persisted `.env` file (lazy — prefer {@link getEnvFile}). */
export const ENV_FILE: string = envFile();

export function getEnvDir(): string { return envDir(); }
export function getEnvFile(): string { return envFile(); }

function parse(contents: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of contents.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

export function loadDotenv(): void {
  const file = envFile();
  if (!existsSync(file)) return;
  try {
    const vars = parse(readFileSync(file, 'utf8'));
    for (const [k, v] of Object.entries(vars)) {
      if (process.env[k] === undefined) process.env[k] = v;
    }
  } catch { /* ignore */ }
}

export function saveKey(key: string, value: string): void {
  const dir = envDir();
  const file = envFile();
  mkdirSync(dir, { recursive: true });
  const existing = existsSync(file) ? parse(readFileSync(file, 'utf8')) : {};
  existing[key] = value;
  const body = Object.entries(existing).map(([k, v]) => `${k}=${v}`).join('\n') + '\n';
  writeFileSync(file, body);
  try { chmodSync(file, 0o600); } catch { /* ignore */ }
  process.env[key] = value;
}
