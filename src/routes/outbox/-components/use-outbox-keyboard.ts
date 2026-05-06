import { useEffect } from 'react';

export interface OutboxKeyboardHandlers<T extends { id: string }> {
  /** Ordered list of items the keyboard cursor walks. */
  items: T[];
  /** Currently focused id, or null when nothing is focused. */
  focusedId: string | null;
  setFocusedId: (id: string | null) => void;

  /** ⌘S — save edits, no status change. Optional. */
  onSave?: (item: T) => void;
  /** ⌘↵ — approve & send. */
  onApprove?: (item: T) => void;
  /** ⌘⇧↵ — approve & advance focus to the next item. */
  onApproveNext?: (item: T) => void;
  /** ⌘⌫ — reject and skip to next. */
  onReject?: (item: T) => void;
  /** ⌘K — open dock chat with draft as seed. */
  onChat?: (item: T) => void;
  /** ⌘⇧K — open resume-session picker. */
  onResume?: (item: T) => void;
  /** ⌘⇧N — open new-session dialog. */
  onNew?: (item: T) => void;

  /** When true, all bindings are inert. Used to suspend during modals etc. */
  disabled?: boolean;
}

/**
 * Outbox-wide keyboard cursor + approval shortcuts. Mirrors the keymap
 * documented on screen 09 (Section L). The contract:
 *
 *   J / K            prev / next draft (no modifier)
 *   ⌘S               save edits
 *   ⌘↵               approve & send (stays on row)
 *   ⌘⇧↵              approve & advance focus to next row
 *   ⌘⌫               reject and skip to next
 *   ⌘K               send to dock chat
 *   ⌘⇧K              continue Claude session (picker)
 *   ⌘⇧N              new Claude session
 *
 * Bindings suspend automatically while focus is on a text input, textarea,
 * select, or contenteditable element — so typing in a subject/body field
 * never triggers a row-level shortcut. ⌘ shortcuts still fire from inside
 * inputs (matches native browser behaviour for save/submit).
 */
export function useOutboxKeyboard<T extends { id: string }>(
  h: OutboxKeyboardHandlers<T>,
) {
  useEffect(() => {
    if (h.disabled) return;

    function isTypingTarget(target: EventTarget | null): boolean {
      const el = target as HTMLElement | null;
      if (!el) return false;
      const tag = el.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
      if (el.isContentEditable) return true;
      return false;
    }

    function onKey(e: KeyboardEvent) {
      const mod = e.metaKey || e.ctrlKey;
      const shift = e.shiftKey;
      const typing = isTypingTarget(e.target);

      const items = h.items;
      const focusedItem =
        h.focusedId != null ? items.find((it) => it.id === h.focusedId) : null;
      const focusedIdx = focusedItem ? items.indexOf(focusedItem) : -1;

      function focusByOffset(delta: number) {
        if (items.length === 0) return;
        if (focusedIdx === -1) {
          h.setFocusedId(items[0]?.id ?? null);
          return;
        }
        const next = Math.max(0, Math.min(items.length - 1, focusedIdx + delta));
        h.setFocusedId(items[next]?.id ?? null);
      }

      // Plain-key (no modifier) shortcuts: only when not typing.
      if (!mod && !shift && !e.altKey && !typing) {
        if (e.key === 'j' || e.key === 'J') {
          e.preventDefault();
          focusByOffset(+1);
          return;
        }
        if (e.key === 'k' || e.key === 'K') {
          e.preventDefault();
          focusByOffset(-1);
          return;
        }
      }

      // ⌘-modified shortcuts: also fire while typing (so ⌘S inside the body
      //   textarea saves as expected).
      if (mod && !e.altKey) {
        // ⌘S — save
        if ((e.key === 's' || e.key === 'S') && !shift) {
          if (focusedItem && h.onSave) {
            e.preventDefault();
            h.onSave(focusedItem);
          }
          return;
        }
        // ⌘↵ / ⌘⇧↵ — approve (+ advance)
        if (e.key === 'Enter') {
          if (!focusedItem) return;
          e.preventDefault();
          if (shift && h.onApproveNext) {
            h.onApproveNext(focusedItem);
            // Advance after approve so the next item is focused immediately.
            const nextIdx = focusedIdx + 1;
            if (nextIdx < items.length) {
              h.setFocusedId(items[nextIdx]!.id);
            }
          } else if (h.onApprove) {
            h.onApprove(focusedItem);
          }
          return;
        }
        // ⌘⌫ — reject + advance
        if (e.key === 'Backspace') {
          if (focusedItem && h.onReject) {
            e.preventDefault();
            h.onReject(focusedItem);
            const nextIdx = focusedIdx + 1;
            if (nextIdx < items.length) {
              h.setFocusedId(items[nextIdx]!.id);
            }
          }
          return;
        }
        // ⌘K / ⌘⇧K — chat / resume
        if (e.key === 'k' || e.key === 'K') {
          if (!focusedItem) return;
          e.preventDefault();
          if (shift && h.onResume) {
            h.onResume(focusedItem);
          } else if (!shift && h.onChat) {
            h.onChat(focusedItem);
          }
          return;
        }
        // ⌘⇧N — new session
        if ((e.key === 'n' || e.key === 'N') && shift) {
          if (focusedItem && h.onNew) {
            e.preventDefault();
            h.onNew(focusedItem);
          }
          return;
        }
      }
    }

    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [
    h.items,
    h.focusedId,
    h.disabled,
    h.setFocusedId,
    h.onSave,
    h.onApprove,
    h.onApproveNext,
    h.onReject,
    h.onChat,
    h.onResume,
    h.onNew,
  ]);
}
