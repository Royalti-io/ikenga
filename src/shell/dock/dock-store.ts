import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { type PaneView } from '@/lib/panes/types';

export type DockState = 'collapsed' | 'expanded' | 'hidden';

export const DOCK_MIN_WIDTH = 240;
export const DOCK_MAX_WIDTH = 900;
export const DOCK_DEFAULT_WIDTH = 380;

interface DockStoreState {
  state: DockState;
  tabs: PaneView[];
  activeIdx: number;
  width: number;

  setState: (s: DockState) => void;
  toggleExpanded: () => void;
  cycleState: () => void;
  setWidth: (n: number) => void;

  addTab: (view: PaneView) => void;
  closeTab: (idx: number) => void;
  switchTab: (idx: number) => void;
  togglePinned: (idx: number) => void;
  /** Pull a view in (e.g., from a pane drop). Activates it. */
  appendView: (view: PaneView) => void;
}

const STATE_CYCLE: DockState[] = ['hidden', 'collapsed', 'expanded'];

const clampWidth = (n: number) =>
  Math.max(DOCK_MIN_WIDTH, Math.min(DOCK_MAX_WIDTH, Math.round(n)));

export const useDockStore = create<DockStoreState>()(
  persist(
    (set, get) => ({
      state: 'collapsed',
      tabs: [],
      activeIdx: 0,
      width: DOCK_DEFAULT_WIDTH,

      setState: (state) => set({ state }),
      toggleExpanded: () =>
        set((s) => ({ state: s.state === 'expanded' ? 'collapsed' : 'expanded' })),
      cycleState: () => {
        const i = STATE_CYCLE.indexOf(get().state);
        const next = STATE_CYCLE[(i + 1) % STATE_CYCLE.length];
        set({ state: next });
      },
      setWidth: (n) => set({ width: clampWidth(n) }),

      addTab: (view) =>
        set((s) => ({ tabs: [...s.tabs, view], activeIdx: s.tabs.length })),
      closeTab: (idx) =>
        set((s) => {
          const tabs = s.tabs.filter((_, i) => i !== idx);
          const activeIdx =
            tabs.length === 0 ? 0 : Math.min(s.activeIdx, tabs.length - 1);
          return { tabs, activeIdx };
        }),
      switchTab: (idx) => set({ activeIdx: idx }),
      togglePinned: (idx) =>
        set((s) => ({
          tabs: s.tabs.map((t, i) => (i === idx ? { ...t, pinned: !t.pinned } : t)),
        })),
      appendView: (view) =>
        set((s) => {
          const next = [...s.tabs, view];
          return {
            tabs: next,
            activeIdx: next.length - 1,
            state: s.state === 'hidden' || s.state === 'collapsed' ? 'expanded' : s.state,
          };
        }),
    }),
    {
      name: 'ikenga-dock',
      version: 2,
      migrate: (persisted: unknown, version) => {
        const p = (persisted ?? {}) as Record<string, unknown>;
        if (version < 2) {
          // v1 had a 'wide' state — collapse it into 'expanded'.
          if (p.state === 'wide') p.state = 'expanded';
          if (p.width == null) p.width = DOCK_DEFAULT_WIDTH;
        }
        return p as unknown as DockStoreState;
      },
    },
  ),
);
