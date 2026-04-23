// Maps between probus concepts and opencode's "<providerID>/<modelID>" model slugs.
//
// We intentionally keep the list small — openai, openrouter, anthropic — because
// those are the ones we have defaults for. Any other opencode providerID will
// still work as long as the matching *_API_KEY env var is set.

export type KnownProvider = 'openai' | 'openrouter' | 'anthropic';

export interface ParsedModel {
  providerID: string;
  modelID: string;
  /** The full original slug, e.g. "openai/gpt-5". */
  slug: string;
}

/**
 * Split `"openai/gpt-5"` → `{ providerID: "openai", modelID: "gpt-5" }`.
 * Everything after the first slash is the model ID (OpenRouter slugs like
 * `openrouter/qwen/qwen3.6-plus` keep the nested provider in modelID).
 */
export function splitModel(slug: string): ParsedModel {
  const idx = slug.indexOf('/');
  if (idx === -1) {
    throw new Error(
      `Model slug must be "<provider>/<model>" (got: ${JSON.stringify(slug)}).`,
    );
  }
  const providerID = slug.slice(0, idx);
  const modelID = slug.slice(idx + 1);
  if (!providerID || !modelID) {
    throw new Error(`Invalid model slug: ${JSON.stringify(slug)}`);
  }
  return { providerID, modelID, slug };
}

export function envVarForProvider(providerID: string): string {
  return `${providerID.toUpperCase().replace(/-/g, '_')}_API_KEY`;
}

/**
 * Pick a provider based on which *_API_KEY is set. Order: OPENROUTER > OPENAI > ANTHROPIC.
 * Returns `null` if none is set — caller should prompt.
 */
export function detectProvider(env: NodeJS.ProcessEnv = process.env): KnownProvider | null {
  if (env.OPENROUTER_API_KEY) return 'openrouter';
  if (env.OPENAI_API_KEY) return 'openai';
  if (env.ANTHROPIC_API_KEY) return 'anthropic';
  return null;
}

export interface ModelDefaults {
  researcher: string;
  qa: string;
}

/**
 * Defaults per provider. Researcher is the per-file model (ran many times);
 * QA is the verifier (ran per verified finding).
 */
export function defaultModels(provider: KnownProvider): ModelDefaults {
  switch (provider) {
    case 'openrouter':
      return {
        researcher: 'openrouter/qwen/qwen3.6-plus',
        qa: 'openrouter/anthropic/claude-opus-4.7',
      };
    case 'openai':
      return {
        researcher: 'openai/gpt-5.4-mini',
        qa: 'openai/gpt-5.4',
      };
    case 'anthropic':
      return {
        researcher: 'anthropic/claude-sonnet-4.6',
        qa: 'anthropic/claude-opus-4.7',
      };
  }
}
