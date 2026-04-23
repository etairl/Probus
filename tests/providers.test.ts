import { describe, it, expect } from 'vitest';
import {
  splitModel,
  envVarForProvider,
  detectProvider,
  defaultModels,
} from '../src/providers.js';

describe('splitModel', () => {
  it('splits a simple slug', () => {
    expect(splitModel('openai/gpt-5.4')).toEqual({
      providerID: 'openai',
      modelID: 'gpt-5.4',
      slug: 'openai/gpt-5.4',
    });
  });

  it('keeps nested model ids intact (openrouter style)', () => {
    const r = splitModel('openrouter/qwen/qwen3.6-plus');
    expect(r.providerID).toBe('openrouter');
    expect(r.modelID).toBe('qwen/qwen3.6-plus');
  });

  it('throws on missing slash', () => {
    expect(() => splitModel('gpt-5')).toThrow();
  });

  it('throws on empty halves', () => {
    expect(() => splitModel('/gpt')).toThrow();
    expect(() => splitModel('openai/')).toThrow();
  });
});

describe('envVarForProvider', () => {
  it('uppercases + suffixes _API_KEY', () => {
    expect(envVarForProvider('openai')).toBe('OPENAI_API_KEY');
    expect(envVarForProvider('openrouter')).toBe('OPENROUTER_API_KEY');
  });

  it('normalizes hyphens to underscores', () => {
    expect(envVarForProvider('some-provider')).toBe('SOME_PROVIDER_API_KEY');
  });
});

describe('detectProvider', () => {
  it('returns null when nothing is set', () => {
    expect(detectProvider({})).toBeNull();
  });

  it('prefers openrouter over openai over anthropic', () => {
    expect(detectProvider({
      OPENROUTER_API_KEY: 'a',
      OPENAI_API_KEY: 'b',
      ANTHROPIC_API_KEY: 'c',
    })).toBe('openrouter');
    expect(detectProvider({ OPENAI_API_KEY: 'b', ANTHROPIC_API_KEY: 'c' })).toBe('openai');
    expect(detectProvider({ ANTHROPIC_API_KEY: 'c' })).toBe('anthropic');
  });
});

describe('defaultModels', () => {
  it('returns openrouter defaults', () => {
    const d = defaultModels('openrouter');
    expect(d.researcher).toBe('openrouter/qwen/qwen3.6-plus');
    expect(d.qa).toBe('openrouter/anthropic/claude-opus-4.7');
  });

  it('returns openai defaults', () => {
    const d = defaultModels('openai');
    expect(d.researcher).toBe('openai/gpt-5.4-mini');
    expect(d.qa).toBe('openai/gpt-5.4');
  });

  it('returns anthropic defaults', () => {
    const d = defaultModels('anthropic');
    expect(d.researcher).toMatch(/^anthropic\//);
    expect(d.qa).toMatch(/^anthropic\//);
  });
});
