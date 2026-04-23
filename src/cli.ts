import type { Effort } from './ui/App.js';
import { detectProvider, defaultModels, type KnownProvider } from './providers.js';

export type ParsedArgs =
  | { kind: 'help' }
  | { kind: 'error'; message: string }
  | { kind: 'view'; repo: string }
  | {
      kind: 'scan';
      repo: string;
      researcherModel: string | null; // null = pick default after key is available
      qaModel: string | null;
      effort: Effort;
      preferredProvider: KnownProvider | null; // from --provider or null = detect
      parallel: number; // how many files to scan concurrently (default 1)
    };

export const DEFAULT_EFFORT: Effort = 'low';
export const DEFAULT_PARALLEL = 1;
const MAX_PARALLEL = 16;

const EFFORTS: ReadonlySet<Effort> = new Set<Effort>(['low', 'medium', 'high']);
const PROVIDERS: ReadonlySet<string> = new Set(['openai', 'openrouter', 'anthropic']);

export function parseArgs(rawArgs: string[]): ParsedArgs {
  if (rawArgs.length === 0 || rawArgs[0] === '--help' || rawArgs[0] === '-h') {
    return { kind: 'help' };
  }

  let effort: Effort = DEFAULT_EFFORT;
  let researcherModel: string | null = null;
  let qaModel: string | null = null;
  let preferredProvider: KnownProvider | null = null;
  let parallel: number = DEFAULT_PARALLEL;
  const positional: string[] = [];

  const takeValue = (flag: string, i: number): [string, number] | string => {
    const eqIdx = rawArgs[i].indexOf('=');
    if (eqIdx !== -1) return [rawArgs[i].slice(eqIdx + 1), i];
    const v = rawArgs[i + 1];
    if (v === undefined) return `Missing value for ${flag}`;
    return [v, i + 1];
  };

  for (let i = 0; i < rawArgs.length; i++) {
    const a = rawArgs[i];
    if (!a) continue;

    if (a === '--effort' || a.startsWith('--effort=')) {
      const r = takeValue('--effort', i);
      if (typeof r === 'string') return { kind: 'error', message: r };
      const [v, next] = r;
      if (!EFFORTS.has(v as Effort)) {
        return { kind: 'error', message: `Invalid --effort value: ${v}. Must be low, medium, or high.` };
      }
      effort = v as Effort;
      i = next;
    } else if (a === '--researchModel' || a === '--research-model' || a.startsWith('--researchModel=') || a.startsWith('--research-model=')) {
      const r = takeValue('--researchModel', i);
      if (typeof r === 'string') return { kind: 'error', message: r };
      researcherModel = r[0]; i = r[1];
    } else if (a === '--qaModel' || a === '--qa-model' || a.startsWith('--qaModel=') || a.startsWith('--qa-model=')) {
      const r = takeValue('--qaModel', i);
      if (typeof r === 'string') return { kind: 'error', message: r };
      qaModel = r[0]; i = r[1];
    } else if (a === '--provider' || a.startsWith('--provider=')) {
      const r = takeValue('--provider', i);
      if (typeof r === 'string') return { kind: 'error', message: r };
      const [v, next] = r;
      if (!PROVIDERS.has(v)) {
        return { kind: 'error', message: `Invalid --provider value: ${v}. Must be openai, openrouter, or anthropic.` };
      }
      preferredProvider = v as KnownProvider;
      i = next;
    } else if (a === '--parallel' || a.startsWith('--parallel=')) {
      const r = takeValue('--parallel', i);
      if (typeof r === 'string') return { kind: 'error', message: r };
      const [v, next] = r;
      const n = Number.parseInt(v, 10);
      if (!Number.isFinite(n) || n < 1 || n > MAX_PARALLEL) {
        return { kind: 'error', message: `Invalid --parallel value: ${v}. Must be an integer between 1 and ${MAX_PARALLEL}.` };
      }
      parallel = n;
      i = next;
    } else if (a.startsWith('--')) {
      return { kind: 'error', message: `Unknown flag: ${a}` };
    } else {
      positional.push(a);
    }
  }

  const [cmd, repo] = positional;

  if (cmd === 'view') {
    if (!repo) return { kind: 'error', message: 'Usage: probus view <repo-path>' };
    return { kind: 'view', repo };
  }

  if (cmd === 'scan') {
    if (!repo) {
      return { kind: 'error', message: 'Usage: probus scan <repo-path> [--effort ...] [--researchModel ...] [--qaModel ...]' };
    }
    return { kind: 'scan', repo, researcherModel, qaModel, effort, preferredProvider, parallel };
  }

  return { kind: 'error', message: `Unknown command: ${cmd ?? '(missing)'}` };
}

/** Resolve model defaults given the provider (detected or explicit). */
export function resolveDefaults(
  preferred: KnownProvider | null,
  env: NodeJS.ProcessEnv = process.env,
): { provider: KnownProvider | null; researcher: string; qa: string } | null {
  const provider = preferred ?? detectProvider(env);
  if (!provider) return null;
  const d = defaultModels(provider);
  return { provider, researcher: d.researcher, qa: d.qa };
}

export const HELP_TEXT = [
  'Usage:',
  '  probus scan <repo-path> [--effort low|medium|high] [--researchModel slug] [--qaModel slug] [--provider openai|openrouter|anthropic] [--parallel N]',
  '  probus view <repo-path>',
  '',
  'Model slugs are "<providerID>/<modelID>", e.g. "openai/gpt-5.4" or',
  '"openrouter/qwen/qwen3.6-plus". If --researchModel / --qaModel are',
  'omitted we pick defaults based on which *_API_KEY is set (openrouter',
  'beats openai beats anthropic). Use --provider to force a pick when',
  'multiple keys are available.',
  '',
  'Effort controls how many files the analyst targets:',
  '  low (default) ≈ 50 files   medium ≈ 100   high ≈ 500',
  '',
  '--parallel N runs N files through researcher+QA concurrently (default 1, max 16).',
].join('\n');
