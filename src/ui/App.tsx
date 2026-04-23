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
import { shutdownOpencode } from '../opencode.js';

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

type Phase = 'api-key' | 'analyst' | 'scanning' | 'done' | 'browse';

export type Effort = 'low' | 'medium' | 'high';
export const EFFORT_FILE_LIMIT: Record<Effort, number> = { low: 50, medium: 100, high: 500 };

interface Props {
  targetRepo: string;
  researcherModel: string | null;
  qaModel: string | null;
  mode?: 'scan' | 'view';
  effort?: Effort;
  preferredProvider?: KnownProvider | null;
}

const PROVIDER_LABEL: Record<KnownProvider, string> = {
  openrouter: 'OpenRouter',
  openai: 'OpenAI',
  anthropic: 'Anthropic',
};

/**
 * Decide which provider we will use and which env var holds its key.
 * If `preferredProvider` is set, we always use that provider (even if its
 * key isn't set yet — we'll prompt for it). Otherwise we try to detect one
 * from the environment, and fall back to openrouter for the prompt.
 */
function resolveActiveProvider(preferred: KnownProvider | null | undefined): KnownProvider {
  if (preferred) return preferred;
  return detectProvider() ?? 'openrouter';
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
    case 'scanning': return 'scanning';
    case 'verifying': return `found ${f.totalFindings ?? 0} — verifying`;
    case 'done':
      if (f.totalFindings === undefined) return 'done';
      return `${f.realFindings ?? 0} real / ${f.totalFindings} found`;
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
}: Props) {
  const { exit } = useApp();
  const activeProvider = resolveActiveProvider(preferredProvider);
  const activeEnvVar = envVarForProvider(activeProvider);
  const defaults = defaultModels(activeProvider);
  const researcherModel = researcherModelProp ?? defaults.researcher;
  const qaModel = qaModelProp ?? defaults.qa;

  // We need keys for whichever providers the two models point at. In the
  // simple single-provider case they collapse to one. If a user passes a
  // custom slug on a different provider, we still only prompt for the one
  // we know how to ask about here — the other will surface as an opencode
  // auth error, which is acceptable for now.
  const requiredProviders = new Set<string>();
  try { requiredProviders.add(splitModel(researcherModel).providerID); } catch { /* invalid slug surfaces later */ }
  try { requiredProviders.add(splitModel(qaModel).providerID); } catch { /* ignore */ }
  requiredProviders.add(activeProvider);
  const missingProviderKey = mode === 'scan'
    ? [...requiredProviders].find(p => !process.env[envVarForProvider(p)])
    : undefined;
  const needsKey = Boolean(missingProviderKey);
  const promptProvider = (missingProviderKey as KnownProvider | undefined) ?? activeProvider;
  const promptEnvVar = envVarForProvider(promptProvider);
  const promptLabel = (PROVIDER_LABEL as Record<string, string>)[promptProvider] ?? promptProvider;

  const [phase, setPhase] = useState<Phase>(
    mode === 'view' ? 'browse' : needsKey ? 'api-key' : 'analyst',
  );
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

  const repoPath = path.resolve(targetRepo);
  const repoSlug = `${path.basename(repoPath).replace(/[^a-zA-Z0-9._-]/g, '_') || 'repo'}-${createHash('sha1').update(repoPath).digest('hex').slice(0, 8)}`;
  const outputDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'output', repoSlug);
  const cacheFile = path.join(outputDir, 'processed-files.txt');

  useInput((input, key) => {
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
      if (input === 's') skipSignal.current?.abort();
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
    if (phase === 'api-key') return;
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

        for (let i = 0; i < initial.length; i++) {
          setCurrentIdx(i);
          if (initial[i].status === 'skipped') continue;

          skipSignal.current = new AbortController();
          let finalStatus: FileStatus = 'done';
          let totalFindings: number | undefined;
          let realFindings: number | undefined;

          for await (const ev of scanAndVerify(
            initial[i].path, repoPath, outputDir, researcherModel, qaModel, skipSignal.current.signal,
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
        }

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

  const realTotal = files.reduce((sum, f) => sum + (f.realFindings ?? 0), 0);
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
            <Text color="gray" dimColor>Mapping out files to create a pentest plan..</Text>
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
                  {total !== undefined && (
                    <Text color="magenta">— {real ?? 0} verified / {total} found</Text>
                  )}
                  {total === undefined && label && (
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
          <Text color="blue">tokens: {tokensDisplay}</Text>
        )}
        {phase === 'analyst' && <Text color="gray" dimColor>q quit</Text>}
        {phase === 'scanning' && <Text color="gray" dimColor>↑↓ navigate  s skip  q quit</Text>}
        {phase === 'done' && <Text color="cyan" bold>✦ Scan complete — no real vulnerabilities  (q to quit)</Text>}
      </Box>
    </Box>
  );
}
