import { forwardRef, useImperativeHandle, useState } from 'react';
import { MessageSquare, Plus, RefreshCw } from 'lucide-react';

import { NewSessionDialog } from '@/shell/sessions/new-session-dialog';
import { ResumeSessionPickerModal } from './resume-session-picker';

export interface HandoffButtonsProps {
  draftId: string;
  /** Subject / title to show in the picker subtitle. */
  draftTitle?: string;
  /** Body text used to seed a fresh session with a "Rewrite" prompt. */
  draftBody?: string;
  /** Agent slug (PA, CMO, …) — used in copy + as filter hint. */
  agentSlug?: string;
  /** Optional cwd hint when spawning a fresh session. */
  projectDir?: string;
  /** Render only one or two buttons in compact contexts (rows etc.). */
  compact?: boolean;
}

/**
 * Imperative handle exposed via ref so parent keyboard shortcuts can trigger
 * the same flows the buttons do. Mirrors screen 09 Section H:
 *  - ⌘K   sendToChat        (TODO: wire into dock chat)
 *  - ⌘⇧K  openResumePicker  (opens ResumeSessionPickerModal)
 *  - ⌘⇧N  openNewSession    (opens NewSessionDialog seeded with draft)
 */
export interface HandoffHandle {
  sendToChat: () => void;
  openResumePicker: () => void;
  openNewSession: () => void;
}

export const HandoffButtons = forwardRef<HandoffHandle, HandoffButtonsProps>(
  function HandoffButtons(
    { draftId, draftTitle, draftBody, agentSlug, projectDir, compact = false },
    ref,
  ) {
    const [pickerOpen, setPickerOpen] = useState(false);
    const [newOpen, setNewOpen] = useState(false);

    const seedPrompt = buildSeedPrompt(draftBody, draftTitle);

    function handleSendToChat() {
      // TODO(handoff): drop the draft + thread context into the dock chat
      // pane. Requires the dock-chat composer to expose a "load with seed"
      // entry point — pending dock-chat refactor.
      console.warn('[outbox/handoff] Send-to-chat stub', {
        draftId,
        draftTitle,
      });
    }

    useImperativeHandle(
      ref,
      () => ({
        sendToChat: handleSendToChat,
        openResumePicker: () => setPickerOpen(true),
        openNewSession: () => setNewOpen(true),
      }),
      [draftId, draftTitle],
    );

    return (
      <>
        <button
          type="button"
          className="ob-btn"
          onClick={handleSendToChat}
          title="Send to dock chat (⌘K)"
        >
          <MessageSquare aria-hidden />
          {compact ? 'Chat' : 'Send to chat'}
          <kbd className="ob-kbd">⌘K</kbd>
        </button>
        <button
          type="button"
          className="ob-btn"
          onClick={() => setPickerOpen(true)}
          title="Continue Claude session (⌘⇧K)"
        >
          <RefreshCw aria-hidden />
          {compact ? 'Resume' : 'Continue session'}
        </button>
        <button
          type="button"
          className="ob-btn"
          onClick={() => setNewOpen(true)}
          title="New Claude session with draft as seed prompt (⌘⇧N)"
        >
          <Plus aria-hidden />
          {compact ? 'New' : 'New session'}
        </button>

        <ResumeSessionPickerModal
          open={pickerOpen}
          onOpenChange={setPickerOpen}
          draftId={draftId}
          draftTitle={draftTitle}
          projectDir={projectDir}
          agentSlug={agentSlug}
          onStartFresh={() => setNewOpen(true)}
        />

        <NewSessionDialog
          open={newOpen}
          onOpenChange={setNewOpen}
          presetPrompt={seedPrompt}
          defaultProjects={projectDir ? [projectDir] : undefined}
        />
      </>
    );
  },
);

function buildSeedPrompt(
  body: string | undefined,
  title: string | undefined,
): string {
  if (!body) return '';
  const subject = title ? `Subject: ${title}\n` : '';
  return `Rewrite the draft below — keep the technical specifics, warm the tone.

— DRAFT —
${subject}${body}`;
}
