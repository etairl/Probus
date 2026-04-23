import React, { useState, useEffect, useRef } from 'react';
import { Box, Text, useApp, useInput } from 'ink';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  isCached,
  markCached,
  ensureOutputDir,
  runAnalyst,
  scanAndVerify,
  listVerifiedReports,
  type VerifiedReport,
} from '../scanner.js';
import { saveKey, ENV_FILE } from '../env.js';
import {
  detectProvider,
  defaultModels,
  envVarForProvider,
  splitModel,
  type KnownProvider,
} from '../providers.js';
// Bifrost lifecycle (spawn/shutdown) is owned by index.tsx; App.tsx doesn't
// manage subprocesses directly anymore.

type FileStatus =
  | 'pending'
  | 'scanning'
  | 'verifying'
  | 'done'
  | 'skipped'
  | 'error';

interface FileEntry {
  path: string;
  status: FileStatus;
  lastThought: string;
  totalFindings?: number;
  realFindings?: number;
}

type Phase = 'provider-select' | 'api-key' | 'analyst' | 'scanning' | 'done' | 'browse';

const PROVIDER_CHOICES: readonly KnownProvider[] = ['openrouter', 'openai', 'anthropic'];

export type Effort = 'low' | 'medium' | 'high';
export const EFFORT_FILE_LIMIT: Record<Effort, number> = { low: 50, medium: 100, high: 500 };

interface Props {
  targetRepo: string;
  researcherModel: string | null;
  qaModel: string | null;
  mode?: 'scan' | 'view';
  effort?: Effort;
  preferredProvider?: KnownProvider | null;
  parallel?: number;
}

const PROVIDER_LABEL: Record<KnownProvider, string> = {
  openrouter: 'OpenRouter',
  openai: 'OpenAI',
  anthropic: 'Anthropic',
};

/**
 * Initial provider choice. `null` means "no preference and nothing detected"
 * — the UI will show a selector so the user can pick one and enter its key.
 */
function resolveInitialProvider(preferred: KnownProvider | null | undefined): KnownProvider | null {
  if (preferred) return preferred;
  return detectProvider();
}

const ICON: Record<FileStatus, string> = {
  pending: ' ',
  scanning: '⚡',
  verifying: '🔎',
  done: '✓',
  skipped: '⊘',
  error: '✗',
};

const COLOR: Record<FileStatus, string> = {
  pending: 'gray',
  scanning: 'yellow',
  verifying: 'magenta',
  done: 'green',
  skipped: 'gray',
  error: 'red',
};

const SEVERITY_COLOR: Record<string, string> = {
  critical: 'red',
  high: 'redBright',
  medium: 'yellow',
  low: 'blue',
};

function statusLabel(f: FileEntry): string {
  switch (f.status) {
    case 'scanning': return 'scanning..';
    case 'verifying': return `${f.totalFindings ?? 0} potential vulnerabilities — verifying..`;
    case 'done':
      if (f.totalFindings === undefined) return 'done';
      return `${f.realFindings ?? 0} verified / ${f.totalFindings} potential vulnerabilities`;
    case 'error': return 'error';
    case 'skipped': return 'skipped';
    default: return '';
  }
}

const SEVERITY_ORDER: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };

export function App({
  targetRepo,
  researcherModel: researcherModelProp,
  qaModel: qaModelProp,
  mode = 'scan',
  effort = 'low',
  preferredProvider = null,
  parallel = 1,
}: Props) {
  const { exit } = useApp();

  // Provider selection: if --provider was passed or any *_API_KEY is set,
  // we already know which provider to use. Otherwise it's null and we ask
  // the user to pick one from a menu.
  const initialProvider = resolveInitialProvider(preferredProvider);
  const [chosenProvider, setChosenProvider] = useState<KnownProvider | null>(initialProvider);
  const [providerCursor, setProviderCursor] = useState<number>(() => {
    const i = PROVIDER_CHOICES.indexOf(initialProvider ?? 'openrouter');
    return i === -1 ? 0 : i;
  });

  // Until the user picks a provider, models fall back to openrouter defaults
  // just so the screen has something to render — the scan doesn't actually
  // start until chosenProvider !== null.
  const activeProvider: KnownProvider = chosenProvider ?? 'openrouter';
  const defaults = defaultModels(activeProvider);
  const researcherModel = researcherModelProp ?? defaults.researcher;
  const qaModel = qaModelProp ?? defaults.qa;

  // Providers whose keys we need. Collapses to one in the common case.
  const requiredProviders = new Set<string>();
  try { requiredProviders.add(splitModel(researcherModel).providerID); } catch { /* invalid slug surfaces later */ }
  try { requiredProviders.add(splitModel(qaModel).providerID); } catch { /* ignore */ }
  requiredProviders.add(activeProvider);
  const missingProviderKey = mode === 'scan' && chosenProvider
    ? [...requiredProviders].find(p => !process.env[envVarForProvider(p)])
    : undefined;
  const needsKey = Boolean(missingProviderKey);
  const promptProvider = (missingProviderKey as KnownProvider | undefined) ?? activeProvider;
  const promptEnvVar = envVarForProvider(promptProvider);
  const promptLabel = (PROVIDER_LABEL as Record<string, string>)[promptProvider] ?? promptProvider;

  const [phase, setPhase] = useState<Phase>(() => {
    if (mode === 'view') return 'browse';
    if (chosenProvider === null) return 'provider-select';
    return needsKey ? 'api-key' : 'analyst';
  });
  const [keyInput, setKeyInput] = useState('');
  const [keyError, setKeyError] = useState<string | null>(null);
  const [analystThought, setAnalystThought] = useState<string>('');
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [currentIdx, setCurrentIdx] = useState(-1);
  const [fatalError, setFatalError] = useState<string | null>(null);
  const [reports, setReports] = useState<VerifiedReport[]>([]);
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [expanded, setExpanded] = useState(false);
  const [reportContent, setReportContent] = useState<string>('');
  const [viewIdx, setViewIdx] = useState<number | null>(null);
  const [tokens, setTokens] = useState(0);
  const running = useRef(false);
  const skipSignal = useRef<AbortController | null>(null);
  // Per-file abort controllers during parallel scanning. `s` aborts whatever
  // the user is currently focused on (viewIdx ?? currentIdx).
  const fileAborts = useRef<Map<number, AbortController>>(new Map());

  const repoPath = path.resolve(targetRepo);
  const repoSlug = `${path.basename(repoPath).replace(/[^a-zA-Z0-9._-]/g, '_') || 'repo'}-${createHash('sha1').update(repoPath).digest('hex').slice(0, 8)}`;
  const outputDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'output', repoSlug);
  const cacheFile = path.join(outputDir, 'processed-files.txt');

  useInput((input, key) => {
    if (phase === 'provider-select') {
      if (key.ctrl && input === 'c') { exit(); return; }
      if (key.upArrow || input === 'k') {
        setProviderCursor(c => Math.max(0, c - 1));
        return;
      }
      if (key.downArrow || input === 'j') {
        setProviderCursor(c => Math.min(PROVIDER_CHOICES.length - 1, c + 1));
        return;
      }
      if (key.return) {
        const picked = PROVIDER_CHOICES[providerCursor];
        setChosenProvider(picked);
        // If the user already has that provider's key in env, skip straight
        // to the scan; otherwise prompt for it.
        const keyPresent = !!process.env[envVarForProvider(picked)];
        setPhase(keyPresent ? 'analyst' : 'api-key');
        return;
      }
      return;
    }
    if (phase === 'api-key') {
      if (key.ctrl && input === 'c') { exit(); return; }
      if (key.return) {
        const trimmed = keyInput.trim();
        if (!trimmed) { setKeyError('Key cannot be empty'); return; }
        try {
          saveKey(promptEnvVar, trimmed);
          process.env[promptEnvVar] = trimmed;
          setKeyError(null);
          setPhase('analyst');
        } catch (err) {
          setKeyError(`Failed to save: ${String(err)}`);
        }
        return;
      }
      if (key.backspace || key.delete) { setKeyInput(s => s.slice(0, -1)); return; }
      if (input && !key.ctrl && !key.meta) setKeyInput(s => s + input);
      return;
    }
    if (input === 'q') { exit(); return; }
    if (phase === 'scanning') {
      if (input === 's') {
        // Skip the focused file (under the ▶ cursor), not every in-flight one.
        const focus = viewIdx ?? currentIdx;
        fileAborts.current.get(focus)?.abort();
      }
      if (key.upArrow || input === 'k') {
        setViewIdx(v => {
          const base = v ?? currentIdx;
          return Math.max(0, base - 1);
        });
      }
      if (key.downArrow || input === 'j') {
        setViewIdx(v => {
          const base = v ?? currentIdx;
          return Math.min(files.length - 1, base + 1);
        });
      }
      return;
    }
    if (phase !== 'browse') {
      if (input === 's') skipSignal.current?.abort();
      return;
    }
    if (expanded) {
      if (key.escape || input === 'h' || key.leftArrow) { setExpanded(false); return; }
    } else {
      if (key.upArrow || input === 'k') setSelectedIdx(i => Math.max(0, i - 1));
      if (key.downArrow || input === 'j') setSelectedIdx(i => Math.min(reports.length - 1, i + 1));
      if (key.return || input === 'l' || key.rightArrow) setExpanded(true);
    }
  });

  useEffect(() => {
    if (phase !== 'browse') return;
    const r = reports[selectedIdx];
    if (!r) { setReportContent(''); return; }
    try {
      setReportContent(existsSync(r.reportPath) ? readFileSync(r.reportPath, 'utf8') : '(report file not found)');
    } catch (err) {
      setReportContent(`(error reading report: ${String(err)})`);
    }
  }, [phase, selectedIdx, reports]);

  useEffect(() => {
    if (running.current) return;
    if (phase === 'api-key' || phase === 'provider-select') return;
    running.current = true;

    if (mode === 'view') {
      if (!existsSync(outputDir)) {
        setFatalError(`No scan output found at ${outputDir}. Run a scan for this repo first.`);
        return;
      }
      const all = listVerifiedReports(outputDir);
      all.sort((a, b) => (SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]) || a.file.localeCompare(b.file));
      if (all.length === 0) {
        setFatalError(`No verified vulnerabilities found in ${outputDir}.`);
        return;
      }
      setReports(all);
      setPhase('browse');
      return;
    }

    (async () => {
      try {
        ensureOutputDir(outputDir);

        // Counter starts at 0 each scan — existing reports on disk are only
        // surfaced in `probus view`, not mixed into the live scan progress.

        skipSignal.current = new AbortController();
        let paths: string[] | null = null;

        for await (const ev of runAnalyst(repoPath, outputDir, researcherModel, EFFORT_FILE_LIMIT[effort], skipSignal.current.signal)) {
          if (ev.type === 'chunk') {
            const lines = ev.text.split('\n').map(l => l.trim()).filter(Boolean);
            if (lines.length > 0) setAnalystThought(lines[lines.length - 1]);
          } else if (ev.type === 'usage') {
            setTokens(t => t + ev.tokens);
          } else if (ev.type === 'files') {
            paths = ev.files;
          } else if (ev.type === 'error') {
            setFatalError(`Analyst: ${ev.text}`);
            return;
          } else if (ev.type === 'skipped') {
            setFatalError('Analyst skipped — cannot continue without file list.');
            return;
          }
        }

        if (!paths) { setFatalError('Analyst produced no file list.'); return; }

        const initial: FileEntry[] = paths.map(p => ({
          path: p,
          status: isCached(p, cacheFile) ? 'skipped' : 'pending',
          lastThought: '',
        }));
        setFiles(initial);
        setPhase('scanning');

        // Worker-pool: up to `parallel` files stream through scanAndVerify
        // concurrently. Each worker claims the next non-skipped index via a
        // shared cursor. UI state is updated per-file using the captured index,
        // so interleaved updates stay correct.
        let cursor = 0;
        const runOne = async (i: number) => {
          setCurrentIdx(prev => (i > prev ? i : prev));

          const ac = new AbortController();
          fileAborts.current.set(i, ac);
          let finalStatus: FileStatus = 'done';
          let totalFindings: number | undefined;
          let realFindings: number | undefined;

          try {
            for await (const ev of scanAndVerify(
              initial[i].path, repoPath, outputDir, researcherModel, qaModel, ac.signal,
            )) {
              if (ev.type === 'chunk') {
                const lines = ev.text.split('\n').map(l => l.trim()).filter(Boolean);
                if (lines.length > 0) {
                  const last = lines[lines.length - 1];
                  setFiles(prev => {
                    const next = [...prev];
                    next[i] = { ...next[i], lastThought: last };
                    return next;
                  });
                }
              } else if (ev.type === 'usage') {
                setTokens(t => t + ev.tokens);
              } else if (ev.type === 'stage') {
                const s: FileStatus = ev.stage === 'scanning' ? 'scanning' : 'verifying';
                setFiles(prev => {
                  const next = [...prev];
                  next[i] = { ...next[i], status: s };
                  return next;
                });
              } else if (ev.type === 'findings') {
                totalFindings = ev.count;
                setFiles(prev => {
                  const next = [...prev];
                  next[i] = { ...next[i], totalFindings: ev.count };
                  return next;
                });
              } else if (ev.type === 'verified') {
                totalFindings = ev.total;
                realFindings = ev.real;
                setFiles(prev => {
                  const next = [...prev];
                  next[i] = { ...next[i], totalFindings: ev.total, realFindings: ev.real };
                  return next;
                });
              } else if (ev.type === 'skipped') {
                finalStatus = 'skipped';
              } else if (ev.type === 'error') {
                finalStatus = 'error';
              }
            }
          } finally {
            fileAborts.current.delete(i);
          }

          setFiles(prev => {
            const next = [...prev];
            next[i] = {
              ...next[i],
              status: finalStatus,
              totalFindings: totalFindings ?? next[i].totalFindings,
              realFindings: realFindings ?? next[i].realFindings,
            };
            return next;
          });
          if (finalStatus === 'done') markCached(initial[i].path, cacheFile);
        };

        const worker = async () => {
          while (true) {
            const i = cursor++;
            if (i >= initial.length) return;
            if (initial[i].status === 'skipped') continue;
            await runOne(i);
          }
        };

        const lanes = Math.max(1, Math.min(parallel, initial.length || 1));
        await Promise.all(Array.from({ length: lanes }, () => worker()));

        const all = listVerifiedReports(outputDir);
        all.sort((a, b) => (SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]) || a.file.localeCompare(b.file));
        setReports(all);
        setPhase(all.length > 0 ? 'browse' : 'done');
      } catch (err) {
        setFatalError(String(err));
      }
    })();
  }, [phase]);

  if (fatalError) {
    return <Text color="red">Fatal: {fatalError}</Text>;
  }

  if (phase === 'provider-select') {
    return (
      <Box flexDirection="column" gap={1}>
        <Text bold color="cyan">Probus</Text>
        <Text color="gray">No API key detected. Pick a provider:</Text>
        <Box flexDirection="column">
          {PROVIDER_CHOICES.map((p, i) => {
            const isSel = i === providerCursor;
            return (
              <Box key={p} gap={1}>
                <Text color={isSel ? 'cyan' : 'gray'}>{isSel ? '▶' : ' '}</Text>
                <Text color={isSel ? 'white' : 'gray'} bold={isSel}>
                  {PROVIDER_LABEL[p]}
                </Text>
                <Text color="gray" dimColor>— {envVarForProvider(p)}</Text>
              </Box>
            );
          })}
        </Box>
        <Text color="gray" dimColor>↑↓ navigate   ↵ select   ctrl+c quit</Text>
      </Box>
    );
  }

  if (phase === 'api-key') {
    return (
      <Box flexDirection="column" gap={1}>
        <Text bold color="cyan">Probus</Text>
        <Text color="yellow">{promptEnvVar} is not set.</Text>
        <Text color="gray">Enter your {promptLabel} API key (will be saved to {ENV_FILE}):</Text>
        <Box>
          <Text color="gray">› </Text>
          <Text color="white">{keyInput.length > 0 ? '*'.repeat(Math.min(keyInput.length, 40)) : ''}</Text>
          <Text color="cyan">▌</Text>
        </Box>
        {keyError && <Text color="red">{keyError}</Text>}
        <Text color="gray" dimColor>↵ submit   ctrl+c quit</Text>
      </Box>
    );
  }

  if (phase === 'browse') {
    const winSize = 10;
    const winStart = Math.max(0, Math.min(selectedIdx - Math.floor(winSize / 2), reports.length - winSize));
    const winEnd = Math.min(reports.length, Math.max(winStart, 0) + winSize);
    const visible = reports.slice(Math.max(winStart, 0), winEnd);

    return (
      <Box flexDirection="column" gap={1}>
        <Box gap={2}>
          <Text bold color="cyan">Probus</Text>
          <Text color="gray">findings:</Text>
          <Text color="magenta" bold>{reports.length}</Text>
        </Box>

        {!expanded && (
          <Box flexDirection="column">
            {winStart > 0 && <Text color="gray" dimColor>  ... {winStart} above</Text>}
            {visible.map((r, wi) => {
              const absoluteIdx = Math.max(winStart, 0) + wi;
              const isSel = absoluteIdx === selectedIdx;
              return (
                <Box key={r.reportPath} gap={1}>
                  <Text color={isSel ? 'cyan' : 'gray'}>{isSel ? '▶' : ' '}</Text>
                  <Text color={SEVERITY_COLOR[r.severity] ?? 'white'} bold>
                    [{r.severity.toUpperCase().padEnd(8)}]
                  </Text>
                  <Text color={isSel ? 'white' : 'gray'}>{r.name}</Text>
                  <Text color="gray" dimColor>— {r.file}</Text>
                </Box>
              );
            })}
            {winEnd < reports.length && (
              <Text color="gray" dimColor>  ... {reports.length - winEnd} below</Text>
            )}
          </Box>
        )}

        {expanded && reports[selectedIdx] && (
          <Box flexDirection="column">
            <Box gap={1}>
              <Text color={SEVERITY_COLOR[reports[selectedIdx].severity] ?? 'white'} bold>
                [{reports[selectedIdx].severity.toUpperCase()}]
              </Text>
              <Text color="white" bold>{reports[selectedIdx].name}</Text>
            </Box>
            <Text color="gray">{reports[selectedIdx].file}</Text>
            <Text color="gray" dimColor>{reports[selectedIdx].reportPath}</Text>
            <Box flexDirection="column" marginTop={1}>
              {reportContent.split('\n').slice(0, 40).map((line, j) => (
                <Text key={j}>{line}</Text>
              ))}
              {reportContent.split('\n').length > 40 && (
                <Text color="gray" dimColor>... (truncated; open file for full report)</Text>
              )}
            </Box>
          </Box>
        )}

        <Box>
          {expanded
            ? <Text color="gray" dimColor>← back   q quit</Text>
            : <Text color="gray" dimColor>↑↓ navigate   ↵ open   q quit</Text>}
        </Box>
      </Box>
    );
  }

  const realTotal =
    files.reduce((sum, f) => sum + (f.realFindings ?? 0), 0);
  const processedCount = files.filter(f =>
    f.status === 'done' || f.status === 'skipped' || f.status === 'error',
  ).length;
  const pct = files.length > 0 ? Math.floor((processedCount / files.length) * 100) : 0;
  const tokensDisplay = tokens >= 1_000_000
    ? `${(tokens / 1_000_000).toFixed(2)}M`
    : tokens >= 1_000
      ? `${(tokens / 1_000).toFixed(1)}k`
      : `${tokens}`;

  const focusIdx = viewIdx ?? currentIdx;
  const winStart = Math.max(0, focusIdx - 1);
  const winEnd = Math.min(files.length, focusIdx + 2);
  const visible = files.slice(winStart, winEnd);

  return (
    <Box flexDirection="column" gap={1}>
      <Box gap={2}>
        <Text bold color="cyan">Probus</Text>
        <Text color="gray">target: <Text color="white">{targetRepo}</Text></Text>
        <Text color="gray">researcher: <Text color="white">{researcherModel}</Text></Text>
        <Text color="gray">qa: <Text color="white">{qaModel}</Text></Text>
      </Box>

      {phase === 'analyst' && (
        <Box flexDirection="column">
          <Text color="yellow">⚡ Learning repo…</Text>
          <Box paddingLeft={3}>
            <Text color="gray" dimColor>Mapping out files to create a vulnerability assessment plan..</Text>
          </Box>
          {analystThought && (
            <Box paddingLeft={3}>
              <Text color="gray" dimColor>{analystThought}</Text>
            </Box>
          )}
        </Box>
      )}

      {phase !== 'analyst' && (
        <Box flexDirection="column">
          {winStart > 0 && <Text color="gray" dimColor>  ↑ {winStart} above</Text>}
          {visible.map((f, wi) => {
            const absIdx = winStart + wi;
            const isProcessing = absIdx === currentIdx;
            const isSelected = absIdx === focusIdx;
            const label = statusLabel(f);
            const total = f.totalFindings;
            const real = f.realFindings;
            return (
              <Box key={f.path} flexDirection="column">
                <Box gap={1}>
                  <Text color={isSelected ? 'cyan' : 'gray'}>{isSelected ? '▶' : ' '}</Text>
                  <Text color={COLOR[f.status]}>{ICON[f.status]}</Text>
                  <Text color={isSelected ? 'white' : 'gray'} bold={isProcessing}>{f.path}</Text>
                  {f.status === 'done' && total !== undefined && (
                    <Text color="magenta">— {real ?? 0} verified / {total} potential vulnerabilities</Text>
                  )}
                  {f.status !== 'done' && label && (
                    <Text color={COLOR[f.status]} dimColor={!isSelected}>— {label}</Text>
                  )}
                </Box>
                {isSelected && f.lastThought && (
                  <Box paddingLeft={3}>
                    <Text color="gray" dimColor>{f.lastThought}</Text>
                  </Box>
                )}
              </Box>
            );
          })}
          {winEnd < files.length && (
            <Text color="gray" dimColor>  ↓ {files.length - winEnd} below</Text>
          )}
        </Box>
      )}

      <Box gap={3}>
        {phase !== 'analyst' && (
          <>
            <Text color="cyan">{pct}%</Text>
            <Text color="magenta">vulnerabilities: {realTotal}</Text>
          </>
        )}
        {(phase === 'analyst' || phase === 'scanning') && (
          <Text color="blue">↓ tokens: {tokensDisplay}</Text>
        )}
        {phase === 'analyst' && <Text color="gray" dimColor>q quit</Text>}
        {phase === 'scanning' && <Text color="gray" dimColor>↑↓ navigate  s skip  q quit</Text>}
        {phase === 'done' && <Text color="cyan" bold>✦ Scan complete — no real vulnerabilities  (q to quit)</Text>}
      </Box>
    </Box>
  );
}
