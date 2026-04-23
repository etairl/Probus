// Thin wrapper around the Claude Agent SDK's streaming `query()` so scanner.ts
// can iterate `{ chunk | done | skipped | error }` events without having to
// know about SDK message shapes.
//
// The SDK spawns the Claude Code CLI as a subprocess and streams back a
// mix of partial-delta events (`stream_event`) and completed messages
// (`assistant`, `result`). We forward text from both:
//   - `stream_event` → `content_block_delta` → `text_delta` / `thinking_delta`
//     (fine-grained for the "last thought" UI line)
//   - `assistant` full blocks as a fallback when partial streaming is absent
//   - `result` ends the generator with the exit code

import { query, type Options } from '@anthropic-ai/claude-agent-sdk';
import { appendFileSync } from 'node:fs';

export type ClaudeAgentEvent =
  | { type: 'chunk'; text: string }
  | { type: 'usage'; tokens: number }
  | { type: 'done'; code: number }
  | { type: 'skipped' }
  | { type: 'error'; text: string };

export interface RunClaudeAgentOpts {
  prompt: string;
  cwd: string;
  /** Model name as the SDK/Claude Code CLI expects it (provider-prefix already stripped if needed). */
  model: string;
  /** Extra env merged over `process.env`. Use this to set ANTHROPIC_API_KEY / ANTHROPIC_BASE_URL. */
  env: Record<string, string | undefined>;
  signal?: AbortSignal;
  logFile?: string;
  stageLabel?: string;
}

function appendLog(logFile: string | undefined, line: string): void {
  if (!logFile) return;
  try { appendFileSync(logFile, line.endsWith('\n') ? line : line + '\n'); } catch { /* ignore */ }
}

export async function* runClaudeAgent(opts: RunClaudeAgentOpts): AsyncGenerator<ClaudeAgentEvent> {
  const { prompt, cwd, model, env, signal, logFile, stageLabel } = opts;
  const tag = stageLabel ? `[${stageLabel}]` : '[agent]';

  const abortController = new AbortController();
  const onExternalAbort = () => abortController.abort();
  if (signal) {
    if (signal.aborted) abortController.abort();
    else signal.addEventListener('abort', onExternalAbort, { once: true });
  }

  const options: Options = {
    cwd,
    model,
    env: { ...process.env, ...env } as Record<string, string | undefined>,
    abortController,
    includePartialMessages: true,
    permissionMode: 'bypassPermissions',
    // Claude Code's default tools (Read/Edit/Write/Bash/Grep/Glob/...) are
    // exactly what we need for the researcher/QA prompts.
    settingSources: [],
  };

  appendLog(logFile, `${tag} starting model=${model} cwd=${cwd}`);

  const q = query({ prompt, options });

  // The SDK emits text/thinking as many tiny deltas per sentence. The UI
  // picks the "last non-empty line" from each chunk we yield — so if we
  // forward every delta raw, the user sees partial words flashing.
  // Buffer until we hit a newline, then flush that completed line. Emit
  // the trailing partial line at end-of-stream so the last sentence isn't
  // lost.
  let buffer = '';
  let emittedOutputThisTurn = 0;
  const flushLine = (): { type: 'chunk'; text: string } | null => {
    const nl = buffer.lastIndexOf('\n');
    if (nl === -1) return null;
    const complete = buffer.slice(0, nl);
    buffer = buffer.slice(nl + 1);
    return { type: 'chunk', text: complete };
  };

  try {
    for await (const msg of q) {
      // Per-type extraction. We deliberately don't model every SDK message
      // type — the ones we skip are fine to ignore (system startup, tool
      // use summaries, rate limit events, etc.).
      if (msg.type === 'stream_event') {
        const ev = (msg as {
          event?: {
            type?: string;
            delta?: { type?: string; text?: string; thinking?: string; stop_reason?: string };
            message?: { usage?: { input_tokens?: number; output_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number } };
            usage?: { output_tokens?: number };
          };
        }).event;

        if (ev?.type === 'content_block_delta' && ev.delta) {
          const d = ev.delta;
          let text: string | undefined;
          if (d.type === 'text_delta') text = d.text;
          else if (d.type === 'thinking_delta') text = d.thinking;
          if (text) {
            appendLog(logFile, `${tag} delta ${JSON.stringify(text)}`);
            buffer += text;
            const out = flushLine();
            if (out) yield out;
          }
        } else if (ev?.type === 'message_start') {
          // Per-turn input tokens arrive up-front; output starts at 0 and
          // grows via message_delta events. Reset the per-turn output
          // counter so cumulative deltas convert to per-turn increments.
          const u = ev.message?.usage;
          if (u) {
            const input = (u.input_tokens ?? 0)
              + (u.cache_creation_input_tokens ?? 0)
              + (u.cache_read_input_tokens ?? 0);
            if (input > 0) yield { type: 'usage', tokens: input };
            emittedOutputThisTurn = u.output_tokens ?? 0;
          }
        } else if (ev?.type === 'message_delta') {
          // `output_tokens` here is cumulative for the current turn.
          const cumulative = ev.usage?.output_tokens ?? 0;
          const inc = cumulative - emittedOutputThisTurn;
          if (inc > 0) {
            emittedOutputThisTurn = cumulative;
            yield { type: 'usage', tokens: inc };
          }
        }
      } else if (msg.type === 'assistant') {
        // Fallback: if partial streaming is disabled or empty, we still surface
        // assistant block text. (If both fire, we'll double-log — but the UI
        // only shows the last line so it's harmless.)
        const blocks = (msg as { message?: { content?: Array<{ type?: string; text?: string; thinking?: string }> } }).message?.content ?? [];
        for (const b of blocks) {
          const text = b.type === 'text' ? b.text : b.type === 'thinking' ? b.thinking : undefined;
          if (text) {
            appendLog(logFile, `${tag} block ${JSON.stringify(text.slice(0, 200))}`);
            // No chunk yield here to avoid duplicating partial-stream output;
            // log-only. If the user disables includePartialMessages later,
            // flip this to yield a chunk.
          }
        }
      } else if (msg.type === 'result') {
        if (buffer.trim()) { yield { type: 'chunk', text: buffer }; buffer = ''; }
        const res = msg as { subtype?: string; is_error?: boolean };
        const ok = res.subtype === 'success' && !res.is_error;
        appendLog(logFile, `${tag} result subtype=${res.subtype} is_error=${res.is_error}`);
        if (ok) {
          yield { type: 'done', code: 0 };
        } else {
          yield { type: 'done', code: 1 };
        }
        return;
      }
    }

    // Stream ended without a result message (shouldn't happen in normal flow).
    if (buffer.trim()) { yield { type: 'chunk', text: buffer }; buffer = ''; }
    appendLog(logFile, `${tag} stream ended without result`);
    yield { type: 'done', code: 0 };
  } catch (err) {
    const aborted = abortController.signal.aborted || (signal?.aborted ?? false);
    if (aborted) {
      appendLog(logFile, `${tag} skipped (aborted)`);
      yield { type: 'skipped' };
      return;
    }
    const text = err instanceof Error ? err.message : String(err);
    appendLog(logFile, `${tag} error ${text}`);
    yield { type: 'error', text };
  } finally {
    if (signal) signal.removeEventListener('abort', onExternalAbort);
  }
}
