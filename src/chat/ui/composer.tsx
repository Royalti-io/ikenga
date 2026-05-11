/**
 * Composer — AI Elements PromptInput (form + Enter/Shift+Enter handling
 * out of the box). Slash commands pass through to the adapter verbatim.
 * Esc cancels while streaming.
 *
 * v2 additions:
 *   - Visible Stop button (not just Esc) when streaming.
 *   - Inline error banner with Retry when the last `send` threw.
 */

import { useMemo, useRef, useState } from 'react';
import { AlertCircle, Square } from 'lucide-react';
import type { ChatStatus } from 'ai';
import { cn } from '@/components/ui/utils';
import {
  PromptInput,
  PromptInputBody,
  PromptInputSubmit,
  PromptInputTextarea,
  type PromptInputMessage,
} from '@/components/ai-elements/prompt-input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { acpSetMode, type AcpSessionModeId } from '@/lib/tauri-cmd';
import { useChatActions, useThreadState } from '../hooks';
import {
  filterSlashCommands,
  useSlashCommands,
  type SlashCommand,
} from '../slash-commands';

interface ComposerProps {
  threadId: string | null;
  className?: string;
  placeholder?: string;
  /**
   * Phase 5: when true, surface the ACP session-mode picker (badge +
   * dropdown) next to the adapter label. The picker calls `acpSetMode`
   * which only the ACP-served path consumes — the legacy chat path
   * (`session_send`) ignores it. Default false because Phase 5 only
   * enables it on `/sessions/$sessionId` routes; Phase 10 reshapes the
   * composer around ACP and this flag goes away.
   *
   * TODO(phase-10): make this unconditional once the composer is fully ACP.
   */
  acpEnabled?: boolean;
}

/** Display labels for the four canonical ACP session modes. Keep in sync
 *  with `src-tauri/src/acp/mode.rs::available_modes`. */
const MODE_LABELS: Record<AcpSessionModeId, string> = {
  plan: 'Plan',
  default: 'Default',
  auto: 'Auto',
  bypassPermissions: 'Bypass',
};
const MODE_IDS: AcpSessionModeId[] = ['plan', 'default', 'auto', 'bypassPermissions'];

export function Composer({ threadId, className, placeholder, acpEnabled }: ComposerProps) {
  const [text, setText] = useState('');
  const state = useThreadState(threadId);
  const { send, cancel, isStreaming, canSend, lastError } = useChatActions(threadId);
  const lastSentRef = useRef<string | null>(null);
  const isSlash = text.trimStart().startsWith('/');

  const slashCommands = useSlashCommands(state?.thread.cwd);
  // Match the first whitespace-delimited token (the slash command name).
  const slashQuery = useMemo(() => {
    if (!isSlash) return null;
    const t = text.trimStart();
    const m = t.match(/^\/([^\s]*)/);
    return m ? m[1] : '';
  }, [isSlash, text]);
  const slashMatches = useMemo(
    () => (slashQuery !== null ? filterSlashCommands(slashCommands, slashQuery) : []),
    [slashCommands, slashQuery],
  );
  const [slashIdx, setSlashIdx] = useState(0);
  // Clamp on list change.
  if (slashIdx >= slashMatches.length && slashMatches.length > 0) {
    setSlashIdx(0);
  }

  function insertSlashCommand(cmd: SlashCommand) {
    // Replace the typed `/foo` prefix with `/cmd ` and keep the rest of
    // whatever the user typed after it.
    const trimmed = text.replace(/^\s*/, '');
    const rest = trimmed.replace(/^\/[^\s]*/, '').replace(/^\s*/, '');
    const next = `/${cmd.name}${rest ? ` ${rest}` : ' '}`;
    setText(next);
  }

  async function handleSubmit(message: PromptInputMessage) {
    const value = message.text;
    if (!value.trim()) return;
    setText('');
    lastSentRef.current = value;
    await send(value);
  }

  function handleRetry() {
    const v = lastSentRef.current;
    if (!v) return;
    void send(v);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Escape' && isStreaming) {
      e.preventDefault();
      void cancel();
      return;
    }
    if (slashMatches.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSlashIdx((i) => Math.min(i + 1, slashMatches.length - 1));
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSlashIdx((i) => Math.max(i - 1, 0));
        return;
      }
      if (e.key === 'Tab') {
        e.preventDefault();
        const pick = slashMatches[slashIdx];
        if (pick) insertSlashCommand(pick);
        return;
      }
    }
  }

  const disabled = !threadId || (!canSend && !isStreaming);
  const adapterLabel = state?.thread.adapterId === 'cli' ? 'Claude CLI' : state?.thread.adapterId;
  const status: ChatStatus = isStreaming ? 'streaming' : 'ready';

  // Phase 5: ACP session-mode picker state. Local-only — the Rust server
  // is the source of truth (`AcpServer.handle_set_mode`), but we mirror
  // it here so the dropdown reflects what we last set. Default `default`
  // matches the spawn-time fallback in `SessionOpts::default`.
  // TODO(phase-10): hydrate from `acpNewSession().modes.currentModeId`
  // when the composer takes over the new_session call itself.
  const [currentMode, setCurrentMode] = useState<AcpSessionModeId>('default');
  const [modeError, setModeError] = useState<string | null>(null);

  async function handleModeChange(next: AcpSessionModeId) {
    if (!threadId) return;
    if (next === currentMode) return;
    const previous = currentMode;
    // Optimistic update — flip back if the Rust side rejects.
    setCurrentMode(next);
    setModeError(null);
    try {
      await acpSetMode(threadId, next);
    } catch (e) {
      setCurrentMode(previous);
      setModeError(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <div
      className={cn(
        'border-t border-border bg-background px-4 py-3',
        className,
      )}
    >
      {lastError && !isStreaming && (
        <div className="mb-2 flex items-start gap-2 rounded-md border border-destructive/50 bg-destructive/10 p-2 text-xs text-destructive">
          <AlertCircle className="mt-0.5 h-3 w-3 shrink-0" />
          <div className="flex-1">
            <span className="font-medium">Send failed.</span>{' '}
            <span className="opacity-80">{lastError}</span>
          </div>
          {lastSentRef.current && (
            <button
              type="button"
              onClick={handleRetry}
              className="shrink-0 rounded border border-destructive/40 px-2 py-0.5 text-[11px] font-medium hover:bg-destructive/15"
            >
              Retry
            </button>
          )}
        </div>
      )}
      {isSlash && slashMatches.length > 0 && (
        <div className="mb-2 overflow-hidden rounded-md border border-border bg-popover text-popover-foreground shadow-sm">
          <div className="border-b border-border bg-muted/40 px-2 py-1 text-[10px] uppercase tracking-wide text-muted-foreground">
            Slash commands — ↑/↓ to choose, Tab to insert
          </div>
          <ul>
            {slashMatches.map((cmd, idx) => (
              <li key={cmd.path}>
                <button
                  type="button"
                  onMouseDown={(e) => {
                    e.preventDefault();
                    insertSlashCommand(cmd);
                  }}
                  className={cn(
                    'flex w-full items-center gap-2 px-2 py-1 text-left text-xs hover:bg-accent',
                    idx === slashIdx && 'bg-accent text-accent-foreground',
                  )}
                >
                  <span className="font-mono">/{cmd.name}</span>
                  <span className="ml-auto text-[10px] uppercase tracking-wide text-muted-foreground">
                    {cmd.source}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
      {isSlash && slashMatches.length === 0 && slashQuery && (
        <div className="mb-2 flex items-center gap-2 text-[11px] text-muted-foreground">
          <span className="rounded bg-muted px-1.5 py-0.5 font-mono">slash command</span>
          <span>
            no <span className="font-mono">/{slashQuery}</span> defined — sent to claude as-is
          </span>
        </div>
      )}
      <PromptInput onSubmit={handleSubmit} className="rounded-md border border-input">
        <PromptInputBody>
          <PromptInputTextarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder={placeholder ?? 'Send a message — Enter to submit, Shift+Enter for newline'}
            disabled={disabled && !isStreaming}
          />
          <div className="flex items-center justify-between gap-2 px-2 py-1.5">
            <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
              <span>{adapterLabel}</span>
              {state?.thread.model && <span>· {state.thread.model.replace(/^claude-/, '')}</span>}
              {acpEnabled && (
                // Phase 5 mode picker: badge-styled trigger + select dropdown.
                // Visual polish is intentionally minimal — Phase 10 reshapes
                // the composer around ACP and the picker gets a proper design pass.
                <Select
                  value={currentMode}
                  onValueChange={(v) => void handleModeChange(v as AcpSessionModeId)}
                  disabled={!threadId}
                >
                  <SelectTrigger
                    className="h-5 gap-1 rounded border border-border bg-muted/40 px-1.5 py-0 text-[10px] font-medium uppercase tracking-wide text-foreground hover:bg-muted [&>svg]:size-3"
                    aria-label="Session mode"
                  >
                    <SelectValue>{MODE_LABELS[currentMode]}</SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    {MODE_IDS.map((m) => (
                      <SelectItem key={m} value={m} className="text-xs">
                        {MODE_LABELS[m]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
              {acpEnabled && modeError && (
                <span className="text-destructive" title={modeError}>
                  · mode change failed
                </span>
              )}
              {isStreaming && <span>· Esc or Stop to cancel</span>}
            </div>
            <div className="flex items-center gap-2">
              {isStreaming && (
                <button
                  type="button"
                  onClick={() => void cancel()}
                  className="inline-flex items-center gap-1 rounded-md border border-input bg-background px-2.5 py-1 text-xs hover:bg-accent"
                  title="Stop generation (Esc)"
                >
                  <Square className="h-3 w-3 fill-current" />
                  Stop
                </button>
              )}
              <PromptInputSubmit
                status={status}
                onStop={() => void cancel()}
                disabled={!isStreaming && (disabled || text.trim().length === 0)}
              />
            </div>
          </div>
        </PromptInputBody>
      </PromptInput>
    </div>
  );
}
