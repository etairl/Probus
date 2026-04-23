import { describe, it, expect } from 'vitest';
import { parseArgs, resolveDefaults } from '../src/cli.js';

describe('parseArgs', () => {
  it('returns help on no args', () => {
    expect(parseArgs([])).toEqual({ kind: 'help' });
  });

  it('returns help on --help / -h', () => {
    expect(parseArgs(['--help']).kind).toBe('help');
    expect(parseArgs(['-h']).kind).toBe('help');
  });

  it('parses view with a repo', () => {
    expect(parseArgs(['view', '../repo'])).toEqual({ kind: 'view', repo: '../repo' });
  });

  it('errors on view without a repo', () => {
    const r = parseArgs(['view']);
    expect(r.kind).toBe('error');
  });

  it('parses scan with defaults (null models + no preferred provider)', () => {
    expect(parseArgs(['scan', '../repo'])).toEqual({
      kind: 'scan',
      repo: '../repo',
      researcherModel: null,
      qaModel: null,
      effort: 'low',
      preferredProvider: null,
    });
  });

  it('parses --researchModel / --qaModel flags', () => {
    const r = parseArgs([
      'scan', '../repo',
      '--researchModel', 'openai/gpt-5.4-mini',
      '--qaModel', 'openai/gpt-5.4',
    ]);
    expect(r).toMatchObject({
      kind: 'scan',
      researcherModel: 'openai/gpt-5.4-mini',
      qaModel: 'openai/gpt-5.4',
    });
  });

  it('accepts hyphenated --research-model / --qa-model aliases', () => {
    const r = parseArgs([
      'scan', '../repo',
      '--research-model=openrouter/qwen/qwen3.6-plus',
      '--qa-model=openrouter/anthropic/claude-opus-4.7',
    ]);
    expect(r).toMatchObject({
      kind: 'scan',
      researcherModel: 'openrouter/qwen/qwen3.6-plus',
      qaModel: 'openrouter/anthropic/claude-opus-4.7',
    });
  });

  it('accepts --provider openai', () => {
    const r = parseArgs(['scan', '../repo', '--provider', 'openai']);
    expect(r.kind === 'scan' && r.preferredProvider).toBe('openai');
  });

  it('rejects invalid --provider', () => {
    const r = parseArgs(['scan', '../repo', '--provider', 'cohere']);
    expect(r.kind).toBe('error');
  });

  it('accepts --effort medium', () => {
    const r = parseArgs(['scan', '../repo', '--effort', 'medium']);
    expect(r.kind === 'scan' && r.effort).toBe('medium');
  });

  it('accepts --effort=high', () => {
    const r = parseArgs(['scan', '--effort=high', '../repo']);
    expect(r.kind === 'scan' && r.effort).toBe('high');
  });

  it('rejects invalid --effort', () => {
    const r = parseArgs(['scan', '../repo', '--effort', 'insane']);
    expect(r.kind).toBe('error');
  });

  it('rejects unknown command', () => {
    expect(parseArgs(['fly']).kind).toBe('error');
  });

  it('rejects unknown flag', () => {
    expect(parseArgs(['scan', '../repo', '--frobnicate']).kind).toBe('error');
  });
});

describe('resolveDefaults', () => {
  it('returns null when no key is set and no preferred provider', () => {
    expect(resolveDefaults(null, {})).toBeNull();
  });

  it('prefers openrouter when its key is set', () => {
    const r = resolveDefaults(null, { OPENROUTER_API_KEY: 'x', OPENAI_API_KEY: 'y' });
    expect(r?.provider).toBe('openrouter');
    expect(r?.researcher).toMatch(/^openrouter\//);
    expect(r?.qa).toMatch(/^openrouter\//);
  });

  it('falls back to openai when only OPENAI_API_KEY is set', () => {
    const r = resolveDefaults(null, { OPENAI_API_KEY: 'y' });
    expect(r?.provider).toBe('openai');
    expect(r?.researcher).toBe('openai/gpt-5.4-mini');
    expect(r?.qa).toBe('openai/gpt-5.4');
  });

  it('honors explicit preferred provider even without env key', () => {
    const r = resolveDefaults('anthropic', {});
    expect(r?.provider).toBe('anthropic');
  });
});
