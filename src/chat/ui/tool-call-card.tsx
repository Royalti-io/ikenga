/**
 * Single tool-use ↔ tool-result pair. Wraps the per-tool renderer in
 * AI Elements <Tool> chrome (Radix Collapsible + status badge). The
 * collapsible header carries a tool-specific title so the summary
 * (e.g. "Bash: ls -la") stays visible when collapsed.
 */

import { cn } from '@/components/ui/utils';
import { Tool, ToolContent, ToolHeader } from '@/components/ai-elements/tool';
import type { PairedToolCall } from '../store';
import { ReadRenderer } from './tool-renderers/read';
import { WriteEditRenderer } from './tool-renderers/write-edit';
import { BashRenderer } from './tool-renderers/bash';
import { TaskRenderer } from './tool-renderers/task';
import { GenericJsonRenderer } from './tool-renderers/generic-json';

interface ToolCallCardProps {
  pair: PairedToolCall;
  threadId: string;
  /** When true, render as a nested child (no card chrome). */
  isChild?: boolean;
}

export function ToolCallCard({ pair, threadId, isChild }: ToolCallCardProps) {
  const isError = pair.result?.isError === true;
  const state = deriveState(pair);
  const title = deriveTitle(pair);

  return (
    <Tool
      defaultOpen={isError}
      className={cn(
        'mb-0 bg-background',
        isChild ? 'border-violet-500/20' : 'border-border',
        isError ? 'border-l-4 border-l-destructive' : '',
      )}
    >
      <ToolHeader type="dynamic-tool" toolName={pair.use.name} title={title} state={state} />
      <ToolContent className="space-y-0 p-3">
        <Renderer pair={pair} threadId={threadId} />
      </ToolContent>
    </Tool>
  );
}

function Renderer({ pair, threadId }: { pair: PairedToolCall; threadId: string }) {
  const name = pair.use.name;
  if (name === 'Read') return <ReadRenderer pair={pair} expanded />;
  if (name === 'Write' || name === 'Edit' || name === 'MultiEdit' || name === 'NotebookEdit')
    return <WriteEditRenderer pair={pair} expanded />;
  if (name === 'Bash') return <BashRenderer pair={pair} expanded />;
  if (name === 'Task') return <TaskRenderer pair={pair} expanded threadId={threadId} />;
  return <GenericJsonRenderer pair={pair} expanded />;
}

// ─── State / title derivation ───────────────────────────────────────────────

type AIToolState =
  | 'input-streaming'
  | 'input-available'
  | 'output-available'
  | 'output-error'
  | 'output-denied'
  | 'approval-requested'
  | 'approval-responded';

function deriveState(pair: PairedToolCall): AIToolState {
  if (!pair.result) return 'input-available';
  if (pair.result.isError) return 'output-error';
  return 'output-available';
}

function deriveTitle(pair: PairedToolCall): string {
  const name = pair.use.name;
  const input = (pair.use.input ?? {}) as Record<string, unknown>;

  if (name === 'Bash') {
    const cmd = typeof input.command === 'string' ? input.command : '';
    return cmd ? `Bash: ${truncate(cmd, 80)}` : 'Bash';
  }
  if (name === 'Read') {
    const p = typeof input.file_path === 'string' ? input.file_path : '';
    return p ? `Read: ${shortenPath(p)}` : 'Read';
  }
  if (name === 'Write' || name === 'Edit' || name === 'MultiEdit' || name === 'NotebookEdit') {
    const p = typeof input.file_path === 'string' ? input.file_path : '';
    return p ? `${name}: ${shortenPath(p)}` : name;
  }
  if (name === 'Task') {
    const desc = typeof input.description === 'string' ? input.description : '';
    return desc ? `Task: ${truncate(desc, 80)}` : 'Task';
  }
  return name;
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

function shortenPath(p: string): string {
  // Show last two segments for compactness.
  const parts = p.split('/');
  if (parts.length <= 2) return p;
  return '…/' + parts.slice(-2).join('/');
}
