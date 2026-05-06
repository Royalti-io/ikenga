/**
 * Composer — AI Elements PromptInput (form + Enter/Shift+Enter handling
 * out of the box). Slash commands pass through to the adapter verbatim.
 * Esc cancels while streaming.
 */

import { useState } from 'react';
import type { ChatStatus } from 'ai';
import { cn } from '@/components/ui/utils';
import {
  PromptInput,
  PromptInputBody,
  PromptInputSubmit,
  PromptInputTextarea,
  type PromptInputMessage,
} from '@/components/ai-elements/prompt-input';
import { useChatActions, useThreadState } from '../hooks';

interface ComposerProps {
  threadId: string | null;
  className?: string;
  placeholder?: string;
}

export function Composer({ threadId, className, placeholder }: ComposerProps) {
  const [text, setText] = useState('');
  const state = useThreadState(threadId);
  const { send, cancel, isStreaming, canSend } = useChatActions(threadId);
  const isSlash = text.trimStart().startsWith('/');

  async function handleSubmit(message: PromptInputMessage) {
    const value = message.text;
    if (!value.trim()) return;
    setText('');
    await send(value);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Escape' && isStreaming) {
      e.preventDefault();
      void cancel();
    }
  }

  const disabled = !threadId || (!canSend && !isStreaming);
  const adapterLabel = state?.thread.adapterId === 'cli' ? 'Claude CLI' : state?.thread.adapterId;
  const status: ChatStatus = isStreaming ? 'streaming' : 'ready';

  return (
    <div
      className={cn(
        'border-t border-border bg-background px-4 py-3',
        className,
      )}
    >
      {isSlash && (
        <div className="mb-2 flex items-center gap-2 text-[11px] text-muted-foreground">
          <span className="rounded bg-muted px-1.5 py-0.5 font-mono">slash command</span>
          <span>passes through to {adapterLabel ?? 'adapter'} verbatim</span>
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
          <div className="flex items-center justify-end gap-2 px-2 py-1.5">
            <PromptInputSubmit
              status={status}
              onStop={() => void cancel()}
              disabled={!isStreaming && (disabled || text.trim().length === 0)}
            />
          </div>
        </PromptInputBody>
      </PromptInput>
      <p className="mt-2 flex items-center gap-2 text-[10px] text-muted-foreground">
        <span>{adapterLabel}</span>
        {state?.thread.model && <span>· {state.thread.model.replace(/^claude-/, '')}</span>}
        {isStreaming && <span>· Esc to cancel</span>}
      </p>
    </div>
  );
}
