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
import { AlertCircle, Square, X } from 'lucide-react';
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
import {
  acpPrompt,
  acpSetMode,
  type AcpContentBlock,
  type AcpSessionModeId,
} from '@/lib/tauri-cmd';
import { useChatActions, useThreadState } from '../hooks';
import {
  filterSlashCommands,
  useSlashCommands,
  type SlashCommand,
} from '../slash-commands';

/**
 * Phase 7: in-memory image attachment state. `base64` is the raw payload
 * we ship to claude (no `data:` URI prefix). `previewUrl` is a data URL
 * built once for the thumbnail strip — keeping it separate from `base64`
 * means we don't re-concatenate the long string on every render.
 */
interface PendingImage {
  id: string;
  mimeType: string;
  base64: string;
  previewUrl: string;
}

/** MIME types claude accepts for input images. We refuse the rest at the
 *  paste/drop boundary so the user sees nothing rather than a confusing
 *  "image type not supported" error from the Anthropic API. */
const SUPPORTED_IMAGE_MIME_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
]);

/** Strip the `data:image/png;base64,` prefix from a FileReader.readAsDataURL
 *  result so we get the raw base64 payload claude wants on the wire. */
function stripDataUrlPrefix(dataUrl: string): string {
  const idx = dataUrl.indexOf(',');
  return idx === -1 ? dataUrl : dataUrl.slice(idx + 1);
}

async function fileToPendingImage(file: File): Promise<PendingImage | null> {
  if (!SUPPORTED_IMAGE_MIME_TYPES.has(file.type)) return null;
  const dataUrl: string = await new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result as string);
    fr.onerror = () => reject(fr.error ?? new Error('FileReader failed'));
    fr.readAsDataURL(file);
  });
  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    mimeType: file.type,
    base64: stripDataUrlPrefix(dataUrl),
    previewUrl: dataUrl,
  };
}

interface ComposerProps {
  threadId: string | null;
  className?: string;
  placeholder?: string;
  /**
   * Phase 5: surfaces the ACP session-mode picker (badge + dropdown) next
   * to the adapter label. Phase 10 makes this default-on — the ACP adapter
   * is the new default chat engine, and the picker pairs with it. Callers
   * can still set `acpEnabled={false}` to mirror the legacy CLI path (used
   * by the opt-out feature flag).
   *
   * TODO(phase-11): retire this flag once the legacy adapter is removed.
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

export function Composer({
  threadId,
  className,
  placeholder,
  acpEnabled = true,
}: ComposerProps) {
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

  // Phase 7: image attachment state. Only consumed when `acpEnabled` is on
  // — the legacy adapter has no image support yet.
  // TODO(phase-10): support images in the legacy adapter, or just retire it.
  const [pendingImages, setPendingImages] = useState<PendingImage[]>([]);

  async function appendImagesFromFiles(files: FileList | File[] | null | undefined) {
    if (!files || !acpEnabled) return;
    const list = Array.from(files);
    const additions: PendingImage[] = [];
    for (const f of list) {
      const img = await fileToPendingImage(f);
      if (img) additions.push(img);
    }
    if (additions.length > 0) {
      setPendingImages((prev) => [...prev, ...additions]);
    }
  }

  async function handlePaste(e: React.ClipboardEvent<HTMLTextAreaElement>) {
    if (!acpEnabled) return; // silent no-op on legacy adapter (Phase 10)
    const files = e.clipboardData?.files;
    if (!files || files.length === 0) return;
    // Only consume the event if there's actually an image — otherwise let
    // text paste flow through to the textarea unimpeded.
    const hasImage = Array.from(files).some((f) => SUPPORTED_IMAGE_MIME_TYPES.has(f.type));
    if (!hasImage) return;
    e.preventDefault();
    await appendImagesFromFiles(files);
  }

  async function handleDrop(e: React.DragEvent<HTMLDivElement>) {
    if (!acpEnabled) return;
    const files = e.dataTransfer?.files;
    if (!files || files.length === 0) return;
    const hasImage = Array.from(files).some((f) => SUPPORTED_IMAGE_MIME_TYPES.has(f.type));
    if (!hasImage) return;
    e.preventDefault();
    await appendImagesFromFiles(files);
  }

  function handleDragOver(e: React.DragEvent<HTMLDivElement>) {
    // Required to allow drop. Only intercept while ACP is on; otherwise
    // let drag events bubble (the legacy adapter ignores them).
    if (!acpEnabled) return;
    e.preventDefault();
  }

  function removePendingImage(id: string) {
    setPendingImages((prev) => prev.filter((p) => p.id !== id));
  }

  async function handleSubmit(message: PromptInputMessage) {
    const value = message.text;
    const hasImages = pendingImages.length > 0;
    if (!value.trim() && !hasImages) return;
    setText('');
    lastSentRef.current = value;

    if (acpEnabled && hasImages && threadId) {
      // Phase 7 hack: bypass the legacy adapter and fire `acpPrompt`
      // directly so the images reach claude's stream-json envelope.
      // Phase 10 reshapes the composer around ACP and this branch goes
      // away (everything routes through one path).
      const images = pendingImages;
      setPendingImages([]);
      const blocks: AcpContentBlock[] = [];
      if (value.trim().length > 0) {
        blocks.push({ type: 'text', text: value });
      }
      for (const img of images) {
        blocks.push({ type: 'image', data: img.base64, mimeType: img.mimeType });
      }
      try {
        await acpPrompt({ sessionId: threadId, prompt: blocks });
      } catch (e) {
        // Surface failures via the same lastError banner the legacy path
        // uses. The hooks layer doesn't own this state for ACP yet, so
        // we just log; Phase 10 unifies error handling.
        console.error('acpPrompt failed:', e);
      }
      return;
    }

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
      onDrop={handleDrop}
      onDragOver={handleDragOver}
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
      {acpEnabled && pendingImages.length > 0 && (
        // Phase 7: thumbnail strip for pasted/dropped images. Minimal
        // visual — Phase 10 refits this when the composer is reshaped
        // around ACP. Each thumb has an inline × to remove it pre-send.
        <div className="mb-2 flex flex-wrap gap-2">
          {pendingImages.map((img) => (
            <div
              key={img.id}
              className="relative h-16 w-16 overflow-hidden rounded border border-border"
            >
              <img
                src={img.previewUrl}
                alt="attachment"
                className="h-full w-full object-cover"
              />
              <button
                type="button"
                onClick={() => removePendingImage(img.id)}
                className="absolute right-0 top-0 flex h-4 w-4 items-center justify-center bg-background/80 text-foreground hover:bg-background"
                aria-label="Remove image"
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          ))}
        </div>
      )}
      <PromptInput onSubmit={handleSubmit} className="rounded-md border border-input">
        <PromptInputBody>
          <PromptInputTextarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onKeyDown}
            onPaste={handlePaste}
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
                disabled={
                  !isStreaming &&
                  (disabled ||
                    (text.trim().length === 0 &&
                      // Phase 7: image-only sends are valid when ACP is on
                      // — the extractor adds a default text anchor on the
                      // Rust side.
                      !(acpEnabled && pendingImages.length > 0)))
                }
              />
            </div>
          </div>
        </PromptInputBody>
      </PromptInput>
    </div>
  );
}
