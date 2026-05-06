// Per-pane "iyke is doing something" activity registry.
//
// Bridge handlers (click/type/key/dom/wait/screenshot) call begin() before
// they start work and end() when they finish. Pane components subscribe via
// useIykeActivity(paneId) and render an overlay. Multiple overlapping
// activities on the same pane are supported — the chip shows the most-
// recent kind, the overlay shows whenever count > 0.
//
// Two safety nets:
//   1. Min visible duration (MIN_VISIBLE_MS): even instant ops (click) leave
//      the overlay up briefly so the user can perceive the activity.
//   2. Stale auto-end (STALE_MS): if a handler crashes without calling end(),
//      the activity is auto-cleared so the overlay doesn't stick forever.
//
// State is in-memory only — no persistence. Always-resets on reload.

import { create } from 'zustand';

export type IykeActivityKind =
  | 'screenshot'
  | 'click'
  | 'type'
  | 'key'
  | 'dom'
  | 'query-cache'
  | 'wait';

export type ActivityScope = string; // pane id, or 'window'

export interface IykeActivity {
  id: string;
  kind: IykeActivityKind;
  scope: ActivityScope;
  startedAt: number;
  detail?: string;
}

const MIN_VISIBLE_MS = 600;
const STALE_MS = 15_000;

interface ActivityStoreState {
  byScope: Record<ActivityScope, IykeActivity[]>;
  begin: (a: Omit<IykeActivity, 'id' | 'startedAt'>) => string;
  end: (id: string) => void;
  /** For debug/devtools — currently unused in production. */
  clear: () => void;
}

let nextId = 0;
function mintId(): string {
  nextId += 1;
  return `act-${nextId}`;
}

export const useIykeActivity = create<ActivityStoreState>((set, get) => ({
  byScope: {},

  begin: (a) => {
    const id = mintId();
    const entry: IykeActivity = {
      id,
      kind: a.kind,
      scope: a.scope,
      detail: a.detail,
      startedAt: Date.now(),
    };
    set((s) => {
      const list = s.byScope[entry.scope] ?? [];
      return { byScope: { ...s.byScope, [entry.scope]: [...list, entry] } };
    });
    // Stale safety: auto-end if nobody calls end() within STALE_MS.
    window.setTimeout(() => {
      const live = get().byScope[entry.scope] ?? [];
      if (live.some((x) => x.id === id)) get().end(id);
    }, STALE_MS);
    return id;
  },

  end: (id) => {
    const state = get();
    let scope: ActivityScope | null = null;
    let entry: IykeActivity | null = null;
    for (const [s, list] of Object.entries(state.byScope)) {
      const found = list.find((x) => x.id === id);
      if (found) {
        scope = s;
        entry = found;
        break;
      }
    }
    if (!scope || !entry) return;

    const elapsed = Date.now() - entry.startedAt;
    const remove = () => {
      set((s) => {
        const list = (s.byScope[scope!] ?? []).filter((x) => x.id !== id);
        const next = { ...s.byScope };
        if (list.length === 0) delete next[scope!];
        else next[scope!] = list;
        return { byScope: next };
      });
    };
    if (elapsed >= MIN_VISIBLE_MS) {
      remove();
    } else {
      window.setTimeout(remove, MIN_VISIBLE_MS - elapsed);
    }
  },

  clear: () => set({ byScope: {} }),
}));

/** Resolve the pane id for a given target element. Walks up looking for the
 *  nearest `data-pane-id`. Returns the literal `'window'` if no pane is found
 *  (e.g. the target is in the activity bar / sidebar). */
export function resolvePaneScope(target: Element | null | undefined): ActivityScope {
  if (!target) return 'window';
  const el = target.closest('[data-pane-id]');
  return el ? (el.getAttribute('data-pane-id') ?? 'window') : 'window';
}
