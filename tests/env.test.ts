import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadDotenv, saveKey, getEnvDir, getEnvFile } from '../src/env.js';

describe('env', () => {
  let tmp: string;
  let origHome: string | undefined;
  let origKey: string | undefined;
  let origOther: string | undefined;

  beforeEach(() => {
    tmp = mkdtempSync(path.join(tmpdir(), 'probus-env-'));
    origHome = process.env.HOME;
    origKey = process.env.OPENROUTER_API_KEY;
    origOther = process.env.OTHER_KEY;
    process.env.HOME = tmp;
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.OTHER_KEY;
  });

  afterEach(() => {
    if (origHome === undefined) delete process.env.HOME; else process.env.HOME = origHome;
    if (origKey === undefined) delete process.env.OPENROUTER_API_KEY; else process.env.OPENROUTER_API_KEY = origKey;
    if (origOther === undefined) delete process.env.OTHER_KEY; else process.env.OTHER_KEY = origOther;
    rmSync(tmp, { recursive: true, force: true });
  });

  it('getEnvDir/getEnvFile reflect the current HOME', () => {
    expect(getEnvDir()).toBe(path.join(tmp, '.probus'));
    expect(getEnvFile()).toBe(path.join(tmp, '.probus', '.env'));
  });

  it('loadDotenv is a no-op when the file does not exist', () => {
    expect(() => loadDotenv()).not.toThrow();
    expect(process.env.OPENROUTER_API_KEY).toBeUndefined();
  });

  it('saveKey writes to ~/.probus/.env and sets process.env', () => {
    saveKey('OPENROUTER_API_KEY', 'sk-or-v1-test');
    expect(process.env.OPENROUTER_API_KEY).toBe('sk-or-v1-test');
    const file = getEnvFile();
    expect(existsSync(file)).toBe(true);
    expect(readFileSync(file, 'utf8')).toContain('OPENROUTER_API_KEY=sk-or-v1-test');
  });

  it('loadDotenv populates process.env from the file', () => {
    mkdirSync(getEnvDir(), { recursive: true });
    writeFileSync(getEnvFile(), 'OPENROUTER_API_KEY=from-file\n# comment\nOTHER_KEY=x\n');
    loadDotenv();
    expect(process.env.OPENROUTER_API_KEY).toBe('from-file');
    expect(process.env.OTHER_KEY).toBe('x');
  });

  it('loadDotenv does not overwrite an already-set var', () => {
    mkdirSync(getEnvDir(), { recursive: true });
    writeFileSync(getEnvFile(), 'OPENROUTER_API_KEY=from-file\n');
    process.env.OPENROUTER_API_KEY = 'already-set';
    loadDotenv();
    expect(process.env.OPENROUTER_API_KEY).toBe('already-set');
  });

  it('saveKey preserves existing keys when adding a new one', () => {
    saveKey('OPENROUTER_API_KEY', 'a');
    saveKey('OTHER_KEY', 'b');
    const contents = readFileSync(getEnvFile(), 'utf8');
    expect(contents).toContain('OPENROUTER_API_KEY=a');
    expect(contents).toContain('OTHER_KEY=b');
  });
});
