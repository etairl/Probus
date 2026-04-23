import { execSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, appendFileSync, mkdirSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { runClaudeAgent } from './claude-agent.js';
import { resolveProviderConfig } from './providers.js';

export interface Finding {
  name: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
  description: string;
  verified?: boolean;
  reason?: string;
}

export interface FileFindings {
  file: string;
  findings: Finding[];
}

export type ScanEvent =
  | { type: 'chunk'; text: string }
  | { type: 'stage'; stage: 'scanning' | 'verifying' }
  | { type: 'findings'; count: number }
  | { type: 'verified'; real: number; total: number }
  | { type: 'usage'; tokens: number }
  | { type: 'done' }
  | { type: 'skipped' }
  | { type: 'error'; text: string };

export type AnalystEvent =
  | { type: 'chunk'; text: string }
  | { type: 'files'; files: string[] }
  | { type: 'usage'; tokens: number }
  | { type: 'error'; text: string }
  | { type: 'skipped' };

export function ensureOutputDir(outputDir: string): void {
  mkdirSync(outputDir, { recursive: true });
  mkdirSync(path.join(outputDir, 'findings'), { recursive: true });
  mkdirSync(path.join(outputDir, 'reports'), { recursive: true });
  mkdirSync(path.join(outputDir, 'debug'), { recursive: true });
}

export function reportsDir(outputDir: string): string {
  return path.join(outputDir, 'reports');
}

export interface VerifiedReport {
  file: string;
  name: string;
  severity: Finding['severity'];
  description: string;
  reason?: string;
  reportPath: string;
}

export function listVerifiedReports(outputDir: string): VerifiedReport[] {
  const findingsDir = path.join(outputDir, 'findings');
  if (!existsSync(findingsDir)) return [];
  const reports: VerifiedReport[] = [];
  for (const entry of readdirSync(findingsDir)) {
    if (!entry.endsWith('.json')) continue;
    let parsed: FileFindings;
    try {
      parsed = validateFindings(readFileSync(path.join(findingsDir, entry), 'utf8'));
    } catch {
      continue;
    }
    const slug = entry.replace(/\.json$/, '');
    parsed.findings.forEach((f, i) => {
      if (f.verified !== true) return;
      reports.push({
        file: parsed.file,
        name: f.name,
        severity: f.severity,
        description: f.description,
        reason: f.reason,
        reportPath: path.join(outputDir, 'reports', `${slug}--${i + 1}.md`),
      });
    });
  }
  return reports;
}

function fileSlug(file: string): string {
  return file.replaceAll('/', '__').replaceAll('\\', '__');
}

export function debugLogPath(outputDir: string, file: string): string {
  return path.join(outputDir, 'debug', `${fileSlug(file)}.log`);
}

function appendDebug(logFile: string, line: string): void {
  try { appendFileSync(logFile, line.endsWith('\n') ? line : line + '\n'); } catch { /* ignore */ }
}

export function isCached(file: string, cacheFile: string): boolean {
  if (!existsSync(cacheFile)) return false;
  return readFileSync(cacheFile, 'utf8').split('\n').includes(file);
}

export function markCached(file: string, cacheFile: string): void {
  appendFileSync(cacheFile, file + '\n');
}

function sanitizePath(p: string): string {
  if (/[\0\r\n<>]/.test(p)) {
    throw new Error(`Unsafe characters in path: ${JSON.stringify(p)}`);
  }
  return p.trim();
}

function analysisPath(outputDir: string): string {
  return path.join(outputDir, 'analysis.json');
}

export function findingsPath(outputDir: string, file: string): string {
  const slug = file.replaceAll('/', '__').replaceAll('\\', '__');
  return path.join(outputDir, 'findings', `${slug}.json`);
}

export function validateAnalysis(json: string): string[] {
  const parsed = JSON.parse(json);
  if (!parsed || typeof parsed !== 'object') throw new Error('not an object');
  const files = (parsed as { files?: unknown }).files;
  if (!Array.isArray(files) || !files.every(f => typeof f === 'string' && f.length > 0)) {
    throw new Error('.files must be a non-empty string[]');
  }
  return files as string[];
}

const VALID_SEVERITIES = new Set(['critical', 'high', 'medium', 'low']);

export function validateFindings(json: string): FileFindings {
  const parsed = JSON.parse(json);
  if (!parsed || typeof parsed !== 'object') throw new Error('not an object');
  const obj = parsed as { file?: unknown; findings?: unknown };
  if (typeof obj.file !== 'string') throw new Error('.file must be string');
  if (!Array.isArray(obj.findings)) throw new Error('.findings must be array');
  for (const f of obj.findings) {
    if (!f || typeof f !== 'object') throw new Error('finding must be object');
    const fo = f as Finding;
    if (typeof fo.name !== 'string') throw new Error('finding.name must be string');
    if (!VALID_SEVERITIES.has(fo.severity)) throw new Error(`finding.severity invalid: ${fo.severity}`);
    if (typeof fo.description !== 'string') throw new Error('finding.description must be string');
    if (fo.verified !== undefined && typeof fo.verified !== 'boolean') throw new Error('finding.verified must be boolean');
    if (fo.reason !== undefined && typeof fo.reason !== 'string') throw new Error('finding.reason must be string');
  }
  return obj as FileFindings;
}

// Runs a one-shot prompt against the Claude Agent SDK. `model` is a slug like
// "openai/gpt-5.4" or "openrouter/qwen/qwen3.6-plus". The API key is pulled
// from the matching env var (e.g. OPENAI_API_KEY, OPENROUTER_API_KEY), and
// the request is routed via ANTHROPIC_BASE_URL or a spawned Bifrost gateway.
async function* runAgent(
  prompt: string,
  cwd: string,
  model: string,
  signal?: AbortSignal,
  logFile?: string,
  stageLabel?: string,
): AsyncGenerator<
  | { type: 'chunk'; text: string }
  | { type: 'usage'; tokens: number }
  | { type: 'done'; code: number }
  | { type: 'skipped' }
  | { type: 'error'; text: string }
> {
  let runtime: Awaited<ReturnType<typeof resolveProviderConfig>>;
  try {
    runtime = await resolveProviderConfig(model);
  } catch (err) {
    yield { type: 'error', text: err instanceof Error ? err.message : String(err) };
    return;
  }

  for await (const ev of runClaudeAgent({
    prompt,
    cwd,
    model: runtime.modelForSDK,
    env: runtime.env,
    signal,
    logFile,
    stageLabel,
  })) {
    yield ev;
  }
}

function analystPrompt(repoPath: string, outputPath: string, fileLimit: number): string {
  const safeOut = sanitizePath(outputPath);
  const safeRepo = sanitizePath(repoPath);
  return `You are an analyst performing reconnaissance on a repository located at ${safeRepo}.

<task>
Identify ~${fileLimit} source files that include entry points or third party dependencies we can later scan for vulnerabilities.

Exclude:
- Test files (*.test.*, *.spec.*, __tests__/)
- Docs, fixtures, examples, generated code
- Pure type definitions, build config, lockfiles, assets
</task>

<output>
Write your result to ${safeOut} as JSON with this exact shape:
{ "files": ["relative/path/one.ts", "relative/path/two.js", ...] }

Paths must be relative to the repo root (${safeRepo}). Do NOT include absolute paths. Do NOT include any other fields.
</output>`;
}

function researcherPrompt(absFile: string, findingsJsonPath: string): string {
  const safeFile = sanitizePath(absFile);
  const safePath = sanitizePath(findingsJsonPath);
  return `You are playing in a CTF. Find vulnerabilities. Start at ${safeFile}.

<output>
Write your findings to ${safePath} as JSON with this exact shape:
{
  "file": "${safeFile}",
  "findings": [
    {
      "name": "<short vulnerability name>",
      "severity": "critical" | "high" | "medium" | "low",
      "description": "<1–3 sentences. Include the specific file path(s).>"
    }
  ]
}

If no real vulnerabilities are found, write { "file": "${safeFile}", "findings": [] }.
Do NOT include any other fields. Only report vulnerabilities that need to be fixed.
</output>`;
}

function qaPrompt(absFile: string, findingsJsonPath: string, reportsDirPath: string, reportSlug: string): string {
  const safeFile = sanitizePath(absFile);
  const safePath = sanitizePath(findingsJsonPath);
  const safeReportsDir = sanitizePath(reportsDirPath);
  const safeSlug = sanitizePath(reportSlug);
  return `You are a senior security QA reviewer. Verify each finding in ${safePath} against the actual source code.

<criteria>
A finding is REAL (verified=true) only if ALL of:
- There is a concrete attacker-reachable code path (taint from untrusted input to the sink)
- The described impact matches what the code actually allows
- No runtime check, framework guard, or upstream validation prevents it
- The described file paths and line numbers exist and match

A finding is a FALSE POSITIVE (verified=false) if any of:
- The code path is dead, unreachable, or gated behind authentication/validation the researcher missed
- The "vulnerability" is safe by construction (e.g. parameterized query, library-enforced escaping)
- Required preconditions are unrealistic (developer-controlled config, not attacker-controlled)
- The cited lines don't actually contain the described bug
- The finding duplicates another finding in the same file
</criteria>

<method>
Re-read ${safeFile} and any other files referenced in each finding. Verify the taint path end-to-end. Be strict: when in doubt, mark as false positive with a clear reason.
</method>

<output>
Rewrite ${safePath} preserving the same shape, adding "verified" and "reason" to each finding:
{
  "file": "${safeFile}",
  "findings": [
    {
      "name": "...",
      "severity": "...",
      "description": "...",
      "verified": true | false,
      "reason": "<one sentence: why you accepted or rejected it>"
    }
  ]
}
Do not drop findings — mark them verified=false instead. Do not add new findings.
</output>

<report_writing>
For EACH finding you mark verified=true, ALSO write a markdown vulnerability report to:
  ${safeReportsDir}/${safeSlug}--<N>.md

Where <N> is the 1-based index of the finding within the "findings" array (the same order as in the JSON — the first verified finding at index 0 becomes 1.md, a finding at index 3 becomes 4.md, etc.). Do NOT renumber based on only-verified; use the original array index.

Do NOT write report files for findings marked verified=false.

Each report must have this structure:

# <finding name>

**Severity:** <critical|high|medium|low>
**File:** <relative or absolute path>

## Summary
<1–2 sentences: what the vulnerability is>

## Vulnerable Code
<code block with file:line references and the specific lines involved>

## Attack Path
<Concrete end-to-end taint path: untrusted input source → transformations → sink. Include a realistic trigger (e.g. HTTP request, CLI args).>

## Impact
<What an attacker gains — be specific.>

## Recommended Fix
<Concrete remediation with code sketch if possible.>

## Verification Notes
<Why you accepted this as real — matches the "reason" field.>
</report_writing>`;
}

// Runs the analyst stage. Caches result at output/analysis.json.
export async function* runAnalyst(
  repoPath: string,
  outputDir: string,
  model: string,
  fileLimit: number,
  signal?: AbortSignal,
): AsyncGenerator<AnalystEvent> {
  const outPath = analysisPath(outputDir);

  if (existsSync(outPath)) {
    try {
      const files = validateAnalysis(readFileSync(outPath, 'utf8'));
      yield { type: 'files', files };
      return;
    } catch {
      // invalid cache — re-run
    }
  }

  const prompt = analystPrompt(repoPath, outPath, fileLimit);
  const logFile = path.join(outputDir, 'debug', 'analyst.log');
  for await (const ev of runAgent(prompt, repoPath, model, signal, logFile, 'analyst')) {
    if (ev.type === 'chunk') yield { type: 'chunk', text: ev.text };
    else if (ev.type === 'usage') yield { type: 'usage', tokens: ev.tokens };
    else if (ev.type === 'skipped') { yield { type: 'skipped' }; return; }
    else if (ev.type === 'error') { yield { type: 'error', text: ev.text }; return; }
    else if (ev.type === 'done' && ev.code !== 0) {
      yield { type: 'error', text: `agent exited with code ${ev.code}` };
      return;
    }
  }

  if (!existsSync(outPath)) {
    const msg = `Analyst did not write ${outPath}`;
    appendDebug(logFile, `[validation] ${msg}`);
    yield { type: 'error', text: msg };
    return;
  }

  try {
    const raw = readFileSync(outPath, 'utf8');
    appendDebug(logFile, `[analysis.json raw]\n${raw}`);
    const files = validateAnalysis(raw);
    yield { type: 'files', files };
  } catch (err) {
    const msg = `Analyst output invalid: ${String(err)}`;
    appendDebug(logFile, `[validation] ${msg}`);
    yield { type: 'error', text: msg };
  }
}

// Per-file pipeline: researcher → QA. Emits stage/chunk/findings/verified events.
export async function* scanAndVerify(
  file: string,
  repoPath: string,
  outputDir: string,
  researcherModel: string,
  qaModel: string,
  signal?: AbortSignal,
): AsyncGenerator<ScanEvent> {
  const absFile = path.resolve(repoPath, file);
  const jsonPath = findingsPath(outputDir, file);
  const logFile = debugLogPath(outputDir, file);

  // Stage 1: Researcher
  yield { type: 'stage', stage: 'scanning' };

  if (existsSync(jsonPath)) {
    // Remove stale findings before re-scan so we know the researcher actually wrote fresh output.
    try { writeFileSync(jsonPath, ''); } catch { /* ignore */ }
  }

  for await (const ev of runAgent(researcherPrompt(absFile, jsonPath), repoPath, researcherModel, signal, logFile, 'researcher')) {
    if (ev.type === 'chunk') yield { type: 'chunk', text: ev.text };
    else if (ev.type === 'usage') yield { type: 'usage', tokens: ev.tokens };
    else if (ev.type === 'skipped') { yield { type: 'skipped' }; return; }
    else if (ev.type === 'error') { yield { type: 'error', text: ev.text }; return; }
    else if (ev.type === 'done' && ev.code !== 0) {
      yield { type: 'error', text: `researcher exited with code ${ev.code}` };
      return;
    }
  }

  let findings: FileFindings;
  try {
    const raw = existsSync(jsonPath) ? readFileSync(jsonPath, 'utf8') : '';
    appendDebug(logFile, `[researcher findings raw]\n${raw || '(file missing or empty)'}`);
    if (!raw.trim()) throw new Error(`empty findings file at ${jsonPath}`);
    findings = validateFindings(raw);
  } catch (err) {
    const msg = `Researcher output invalid: ${String(err)}`;
    appendDebug(logFile, `[validation] ${msg}`);
    yield { type: 'error', text: msg };
    return;
  }

  yield { type: 'findings', count: findings.findings.length };

  if (findings.findings.length === 0) {
    yield { type: 'verified', real: 0, total: 0 };
    yield { type: 'done' };
    return;
  }

  // Stage 2: QA
  yield { type: 'stage', stage: 'verifying' };

  const reportsPath = reportsDir(outputDir);
  const reportSlug = fileSlug(file);
  for await (const ev of runAgent(qaPrompt(absFile, jsonPath, reportsPath, reportSlug), repoPath, qaModel, signal, logFile, 'qa')) {
    if (ev.type === 'chunk') yield { type: 'chunk', text: ev.text };
    else if (ev.type === 'usage') yield { type: 'usage', tokens: ev.tokens };
    else if (ev.type === 'skipped') { yield { type: 'skipped' }; return; }
    else if (ev.type === 'error') { yield { type: 'error', text: ev.text }; return; }
    else if (ev.type === 'done' && ev.code !== 0) {
      yield { type: 'error', text: `qa exited with code ${ev.code}` };
      return;
    }
  }

  try {
    const raw = existsSync(jsonPath) ? readFileSync(jsonPath, 'utf8') : '';
    appendDebug(logFile, `[qa findings raw]\n${raw || '(file missing or empty)'}`);
    findings = validateFindings(raw);
  } catch (err) {
    const msg = `QA output invalid: ${String(err)}`;
    appendDebug(logFile, `[validation] ${msg}`);
    yield { type: 'error', text: msg };
    return;
  }

  const real = findings.findings.filter(f => f.verified === true).length;
  yield { type: 'verified', real, total: findings.findings.length };
  yield { type: 'done' };
}

// Kept for ad-hoc use; not part of the main pipeline anymore.
export function gitListFiles(repoPath: string): string[] {
  const out = execSync('git ls-files -z', { cwd: repoPath }).toString();
  return out.split('\0').filter(Boolean);
}
