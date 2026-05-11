/**
 * Renderer for Anthropic's built-in `AskUserQuestion` tool. The tool input
 * is a list of questions, each with options (label + description) and an
 * optional `multiSelect` flag. The expected output is a JSON object mapping
 * each question's text to the user's selected label(s).
 *
 * Shape captured 2026-05-11 against Claude Code (the tool is invoked as
 * `mcp__anthropic__AskUserQuestion` or the unscoped `AskUserQuestion`):
 *
 *   input.questions: Array<{
 *     question: string,
 *     header: string,
 *     multiSelect: boolean,
 *     options: Array<{ label: string, description?: string, preview?: string }>,
 *   }>
 *
 * Submit semantics:
 *   - Single-select: value is the label string (or `Other: <text>` when the
 *     user picks Other and types in the free-form field).
 *   - Multi-select: value is an array of label strings.
 *   - Output envelope: `{ answers: Record<question, value> }`.
 *
 * If the tool already has a `result` (which happens when the user dismisses
 * the question via a "regular" chat reply and Claude moves on with
 * defaults), we render the answers read-only.
 */

import { useState } from 'react';
import { AlertTriangle, Loader2, Send } from 'lucide-react';
import { Markdown } from '@/components/markdown';
import { cn } from '@/components/ui/utils';
import { sessionSend, sessionToolResult } from '@/lib/tauri-cmd';
import { appendUserTurn } from '../../persist';
import { useChatStore } from '../../store';
import type { PairedToolCall } from '../../store';

interface AskUserQuestionInput {
  questions: AskUserQuestionEntry[];
}

interface AskUserQuestionEntry {
  question: string;
  header?: string;
  multiSelect?: boolean;
  options: AskUserQuestionOption[];
}

interface AskUserQuestionOption {
  label: string;
  description?: string;
  preview?: string;
}

const OTHER_LABEL = 'Other';

interface AskUserQuestionRendererProps {
  pair: PairedToolCall;
  threadId: string;
}

export function AskUserQuestionRenderer({ pair, threadId }: AskUserQuestionRendererProps) {
  const input = (pair.use.input ?? {}) as Partial<AskUserQuestionInput>;
  const questions = input.questions ?? [];
  // A tool_result with isError=true means Claude's CLI auto-errored the
  // AskUserQuestion call (its built-in implementation requires the TUI,
  // not the --print streaming mode we use). Treat that as "not yet
  // answered" so the user can still respond — we'll send the answer back
  // as both a tool_result (in case the loop is still listening) and a
  // follow-up user message (which is what actually gets through).
  const errored = pair.result !== null && pair.result.isError === true;
  const alreadyAnswered = pair.result !== null && !errored;

  // Per-question state. Single-select: { kind: 'single', value: string | null,
  // otherText: string }. Multi-select: { kind: 'multi', values: Set<string>,
  // otherText: string }.
  const [answers, setAnswers] = useState<QuestionAnswer[]>(() =>
    questions.map((q) =>
      q.multiSelect
        ? { kind: 'multi', values: new Set<string>(), otherText: '' }
        : { kind: 'single', value: null, otherText: '' },
    ),
  );
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  if (questions.length === 0) {
    return (
      <div className="text-xs text-muted-foreground">
        AskUserQuestion called with no questions — nothing to render.
      </div>
    );
  }

  function setSingle(qIdx: number, value: string) {
    setAnswers((prev) => {
      const next = [...prev];
      const cur = next[qIdx];
      if (cur.kind === 'single') {
        next[qIdx] = { ...cur, value };
      }
      return next;
    });
  }

  function toggleMulti(qIdx: number, value: string) {
    setAnswers((prev) => {
      const next = [...prev];
      const cur = next[qIdx];
      if (cur.kind === 'multi') {
        const values = new Set(cur.values);
        if (values.has(value)) values.delete(value);
        else values.add(value);
        next[qIdx] = { ...cur, values };
      }
      return next;
    });
  }

  function setOtherText(qIdx: number, otherText: string) {
    setAnswers((prev) => {
      const next = [...prev];
      next[qIdx] = { ...next[qIdx], otherText };
      return next;
    });
  }

  const canSubmit =
    !alreadyAnswered &&
    !submitting &&
    questions.every((_, i) => {
      const a = answers[i];
      if (a.kind === 'single') {
        if (!a.value) return false;
        if (a.value === OTHER_LABEL && !a.otherText.trim()) return false;
        return true;
      }
      // multi-select: at least one option chosen, and if Other is chosen the
      // free-form field must not be empty.
      if (a.values.size === 0) return false;
      if (a.values.has(OTHER_LABEL) && !a.otherText.trim()) return false;
      return true;
    });

  async function submit() {
    setSubmitting(true);
    setSubmitError(null);
    try {
      const out: Record<string, unknown> = {};
      const lines: string[] = [];
      questions.forEach((q, i) => {
        const a = answers[i];
        let v: unknown;
        if (a.kind === 'single' && a.value) {
          v = a.value === OTHER_LABEL ? `Other: ${a.otherText.trim()}` : a.value;
        } else if (a.kind === 'multi') {
          v = Array.from(a.values).map((x) =>
            x === OTHER_LABEL ? `Other: ${a.otherText.trim()}` : x,
          );
        }
        out[q.question] = v;
        const fmt = Array.isArray(v) ? v.join(', ') : String(v);
        lines.push(`- **${q.question}**: ${fmt}`);
      });

      // First: try the tool_result envelope. If the tool was auto-errored
      // by Claude's CLI in --print mode (the common case), this won't
      // reach the model — but if for any reason the loop is still waiting
      // for an answer, it lands cleanly. Best-effort, swallow failures.
      try {
        await sessionToolResult(threadId, pair.use.id, { answers: out });
      } catch (e) {
        console.debug('sessionToolResult (AskUserQuestion):', e);
      }

      // Then: send a follow-up user message so Claude actually sees the
      // answer in its next turn, regardless of whether the tool_result
      // landed. Persisted as a user_turn so it renders in the thread.
      const followup = `Answers to your AskUserQuestion:\n${lines.join('\n')}`;
      if (errored) {
        const turn = await appendUserTurn(threadId, followup);
        useChatStore.getState().appendEvents(threadId, [
          {
            kind: 'user_turn',
            text: turn.text,
            sequence: turn.sequence,
            createdAt: turn.createdAt,
          },
        ]);
        await sessionSend(threadId, followup);
      }
    } catch (e) {
      setSubmitError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="space-y-4">
      {errored && (
        <div className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-2 text-xs text-amber-700 dark:text-amber-300">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <div>
            Claude's CLI auto-errored this question because{' '}
            <code className="font-mono">--print</code> streaming mode has no
            interactive terminal. Answer below — we'll relay your answer as a
            follow-up message so it lands in Claude's next turn.
          </div>
        </div>
      )}
      {questions.map((q, i) => (
        <QuestionBlock
          key={`q-${i}`}
          q={q}
          answer={answers[i]}
          disabled={alreadyAnswered || submitting}
          onSingle={(v) => setSingle(i, v)}
          onToggleMulti={(v) => toggleMulti(i, v)}
          onOther={(t) => setOtherText(i, t)}
        />
      ))}

      {alreadyAnswered ? (
        <div className="rounded-md border border-border bg-muted/30 p-2 text-[11px] text-muted-foreground">
          Answered — submitting again has no effect.
        </div>
      ) : (
        <div className="flex items-center justify-between gap-2">
          <span className="text-[11px] text-muted-foreground">
            Answers go straight to Claude's agent loop as a tool_result.
          </span>
          <div className="flex items-center gap-2">
            {submitError && (
              <span className="text-[11px] text-destructive">{submitError}</span>
            )}
            <button
              type="button"
              onClick={() => void submit()}
              disabled={!canSubmit}
              className={cn(
                'inline-flex items-center gap-1.5 rounded-md border border-input bg-background px-3 py-1.5 text-xs',
                canSubmit
                  ? 'hover:bg-accent'
                  : 'cursor-not-allowed opacity-50',
              )}
            >
              {submitting ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <Send className="h-3 w-3" />
              )}
              Answer
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

interface QuestionBlockProps {
  q: AskUserQuestionEntry;
  answer: QuestionAnswer;
  disabled: boolean;
  onSingle: (value: string) => void;
  onToggleMulti: (value: string) => void;
  onOther: (text: string) => void;
}

function QuestionBlock({
  q,
  answer,
  disabled,
  onSingle,
  onToggleMulti,
  onOther,
}: QuestionBlockProps) {
  // Anthropic always offers Other as an implicit final option; surface it
  // even if Claude didn't list it.
  const options: AskUserQuestionOption[] = [
    ...q.options,
    ...(q.options.some((o) => o.label === OTHER_LABEL)
      ? []
      : [{ label: OTHER_LABEL, description: 'Free-form answer' }]),
  ];

  const showOtherInput =
    answer.kind === 'single'
      ? answer.value === OTHER_LABEL
      : answer.values.has(OTHER_LABEL);

  return (
    <div className="space-y-2 rounded-md border border-border bg-background p-3">
      <div className="flex items-baseline gap-2">
        {q.header && (
          <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
            {q.header}
          </span>
        )}
        <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
          {q.multiSelect ? 'pick any' : 'pick one'}
        </span>
      </div>
      <div className="text-sm font-medium">
        <Markdown content={q.question} density="compact" />
      </div>
      <div className="space-y-1.5">
        {options.map((opt) => {
          const selected =
            answer.kind === 'single'
              ? answer.value === opt.label
              : answer.values.has(opt.label);
          return (
            <label
              key={opt.label}
              className={cn(
                'flex cursor-pointer items-start gap-2 rounded-md border border-transparent px-2 py-1.5 text-xs',
                'hover:bg-accent/30',
                selected && 'border-primary/40 bg-primary/5',
                disabled && 'cursor-not-allowed opacity-60',
              )}
            >
              <input
                type={q.multiSelect ? 'checkbox' : 'radio'}
                name={`q-${q.question}`}
                checked={selected}
                disabled={disabled}
                onChange={() => {
                  if (q.multiSelect) onToggleMulti(opt.label);
                  else onSingle(opt.label);
                }}
                className="mt-0.5 shrink-0"
              />
              <span className="flex-1">
                <span className="font-medium">{opt.label}</span>
                {opt.description && (
                  <span className="ml-2 text-muted-foreground">{opt.description}</span>
                )}
              </span>
            </label>
          );
        })}
      </div>
      {showOtherInput && (
        <input
          type="text"
          value={answer.otherText}
          disabled={disabled}
          onChange={(e) => onOther(e.target.value)}
          placeholder="Your answer…"
          className="w-full rounded-md border border-input bg-background px-2 py-1 text-xs"
        />
      )}
    </div>
  );
}

type QuestionAnswer =
  | { kind: 'single'; value: string | null; otherText: string }
  | { kind: 'multi'; values: Set<string>; otherText: string };
