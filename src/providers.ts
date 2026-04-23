// Maps between probus model slugs ("<providerID>/<modelID>") and the
// Claude Agent SDK, which only speaks the Anthropic wire protocol.
//
// Providers are supported by swapping `ANTHROPIC_API_KEY` / `ANTHROPIC_BASE_URL`
// at subprocess-spawn time:
//   - anthropic  → native
//   - openrouter → ANTHROPIC_BASE_URL=https://openrouter.ai/api
//   - openai     → spawn Bifrost (Anthropic→OpenAI translator) and point
//                  ANTHROPIC_BASE_URL at http://127.0.0.1:<port>

import { ensureBifrost } from './bifrost.js';

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

export interface ProviderRuntime {
  /** Extra env vars to inject into the Claude Code subprocess. */
  env: Record<string, string | undefined>;
  /** Model name as Claude Code expects it (provider prefix usually stripped). */
  modelForSDK: string;
}

/**
 * Given a model slug, resolve how to run it against the Claude Agent SDK:
 * which `ANTHROPIC_*` env vars to set and which model name to pass through.
 *
 * Callers must already have the provider's *_API_KEY in process.env (the UI
 * prompts for it before we get here).
 */
export async function resolveProviderConfig(slug: string): Promise<ProviderRuntime> {
  const { providerID, modelID } = splitModel(slug);
  const keyVar = envVarForProvider(providerID);
  const apiKey = process.env[keyVar];
  if (!apiKey) {
    throw new Error(`${keyVar} is not set — required for provider "${providerID}"`);
  }

  if (providerID === 'anthropic') {
    return {
      env: { ANTHROPIC_API_KEY: apiKey },
      modelForSDK: modelID,
    };
  }

  if (providerID === 'openrouter') {
    return {
      env: {
        ANTHROPIC_API_KEY: apiKey,
        ANTHROPIC_BASE_URL: 'https://openrouter.ai/api',
      },
      modelForSDK: modelID,
    };
  }

  if (providerID === 'openai') {
    const baseURL = await ensureBifrost(apiKey);
    return {
      env: {
        // Bifrost doesn't check this, but the SDK/CLI insists on a non-empty value.
        ANTHROPIC_API_KEY: 'bifrost-dummy',
        ANTHROPIC_BASE_URL: baseURL,
      },
      // Bifrost uses the provider-prefixed slug to route to OpenAI.
      modelForSDK: slug,
    };
  }

  throw new Error(`Unsupported provider: ${providerID}`);
}
