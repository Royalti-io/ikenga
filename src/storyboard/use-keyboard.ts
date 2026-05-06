/**
 * Keyboard shortcuts for the storyboard editor. Ported from
 * storyboard-app/src/hooks/useKeyboard.ts with one critical addition: gate by
 * `document.activeElement` so PA's chat input / command palette / typing
 * elsewhere doesn't accidentally approve beats.
 */

import { useEffect } from "react";

export interface KeyboardHandlers {
  onPrevBeat: () => void;
  onNextBeat: () => void;
  onPrevRung: () => void;
  onNextRung: () => void;
  onApprove: () => void;
  onNeedsRework: () => void;
  onFocusComment: () => void;
  onSendNote: () => void;
  onToggleTweak: () => void;
  onCycleFiltersBack: () => void;
  onCycleFiltersForward: () => void;
}

function isTypingTarget(el: Element | null): boolean {
  if (!el) return false;
  const tag = el.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  if ((el as HTMLElement).isContentEditable) return true;
  return false;
}

export function useKeyboard(handlers: KeyboardHandlers, enabled: boolean) {
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (isTypingTarget(document.activeElement)) return;

      switch (e.key) {
        case "ArrowLeft":
          e.preventDefault();
          handlers.onPrevBeat();
          break;
        case "ArrowRight":
          e.preventDefault();
          handlers.onNextBeat();
          break;
        case "ArrowUp":
          e.preventDefault();
          handlers.onPrevRung();
          break;
        case "ArrowDown":
          e.preventDefault();
          handlers.onNextRung();
          break;
        case "a":
        case "A":
          e.preventDefault();
          handlers.onApprove();
          break;
        case "r":
        case "R":
          e.preventDefault();
          handlers.onNeedsRework();
          break;
        case "c":
        case "C":
          e.preventDefault();
          handlers.onFocusComment();
          break;
        case "n":
        case "N":
          e.preventDefault();
          handlers.onSendNote();
          break;
        case "e":
        case "E":
          e.preventDefault();
          handlers.onToggleTweak();
          break;
        case "[":
          e.preventDefault();
          handlers.onCycleFiltersBack();
          break;
        case "]":
          e.preventDefault();
          handlers.onCycleFiltersForward();
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [handlers, enabled]);
}
