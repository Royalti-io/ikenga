import { useEffect, useMemo, useState } from 'react';
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels';
import { ActivityBar } from './activity-bar';
import { Sidebar } from './sidebar';
import { ContentPane } from './content-pane';
import { Dock } from './dock/dock';
import { useDockStore } from './dock/dock-store';
import { CommandPalette, useCommandPalette } from './command-palette';
import { ConnectorBanner } from './connector-banner';
import { debounce, loadLayoutState, saveLayoutState } from '@/lib/layout-state';
import { useIykeBridge } from '@/lib/iyke/bridge';
import { useIykeControlListener } from '@/lib/iyke/control-listener';
import { useIykeShellSync } from '@/lib/iyke/use-iyke-shell-sync';
import { useScreenshotListener } from '@/lib/use-screenshot-listener';
import { usePreloadViewers } from '@/lib/use-preload-viewers';
import { dumpBootTimings, mark } from '@/lib/boot-timing';
import { usePaneStore } from '@/lib/panes/pane-store';
import { loadPaneTree, persistPaneTree } from '@/lib/panes/pane-persistence';
import { useRouterPaneSync } from '@/lib/panes/router-pane-sync';
import { useTerminalStore } from '@/terminal/session-store';
import { createTerminalSession } from '@/terminal/single-terminal';

const LAYOUT_KEY = 'workspace.panels';
// [sidebar, content]. The right SidePane is gone — terminal/chat/file
// views live as pane tabs now.
const DEFAULT_SIZES: [number, number] = [16, 84];

export function Workspace() {
  const [initialSizes, setInitialSizes] = useState<[number, number] | null>(null);
  const [navHidden, setNavHidden] = useState(false);
  const palette = useCommandPalette();

  // Iyke (phase 11): mirror sidebar mode + focused pane's route into the
  // Rust-side control bridge so external CLI/MCP callers see what the
  // user sees. Mounted only here so it never fires inside a pane's
  // memory-router re-render.
  useIykeShellSync();
  // Counterpart for the write side: subscribe to iyke:* Tauri events
  // emitted by the Rust handlers and translate them into pane/shell
  // store mutations. Same mounting reasoning — workspace-level only.
  useIykeControlListener();
  // Phase A: console + fetch shims, DOM/click/type/key/wait/query-cache
  // listeners. Mount once at workspace level only.
  useIykeBridge();
  // Bidirectional sync between the address bar and the focused pane's
  // route. Workspace level only — each pane's RouteView memory router
  // stays an internal detail.
  useRouterPaneSync();
  // Screenshot capture bridge: turn `screenshot://request` events into
  // DOM-to-PNG renders, and `screenshot://shortcut` events into Tauri
  // command invocations (resolves "focused pane" client-side).
  useScreenshotListener();
  // Warm the lazy artifact viewer chunks during idle so the first
  // PDF/XLSX/code file open isn't a cold fetch.
  usePreloadViewers();
  // Note: the mbox sync scheduler that used to live here moved into the
  // com.ikenga.email pkg's manifest cron when the strip-down landed.

  // Boot-timing checkpoint (see src/lib/boot-timing.ts). Fires once per
  // process — the marks are no-ops on warm reloads.
  useEffect(() => {
    mark('boot:workspace-mount');
  }, []);

  // Hydrate persisted sizes once on mount.
  useEffect(() => {
    let cancelled = false;
    loadLayoutState<[number, number]>(LAYOUT_KEY, DEFAULT_SIZES).then((sizes) => {
      if (!cancelled) {
        // Migrate old 3-tuple persisted layouts (sidebar/content/sidepane)
        // into the new 2-tuple layout.
        const next: [number, number] =
          (sizes as unknown as number[]).length === 2
            ? (sizes as [number, number])
            : DEFAULT_SIZES;
        setInitialSizes(next);
        // Workspace is now interactive — log the cold-start trace.
        // Microtask delay so the mark lands after React commits.
        queueMicrotask(() => {
          mark('boot:workspace-ready');
          dumpBootTimings();
        });
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Persist on layout change (debounced to avoid hammering SQLite while
  // the user is mid-drag).
  const persist = useMemo(
    () =>
      debounce((sizes: number[]) => {
        if (sizes.length === 2) {
          void saveLayoutState(LAYOUT_KEY, sizes);
        }
      }, 500),
    []
  );

  // Rehydrate terminal sessions, then the pane tree, then start
  // persisting pane-tree changes. Order matters: pane-persistence
  // checks useTerminalStore for live session ids when filtering
  // restored terminal tabs. Persistence subscriber only attaches after
  // hydrate to avoid clobbering the saved blob with the initial
  // (default) tree.
  useEffect(() => {
    let unsubPersist: (() => void) | null = null;
    let cancelled = false;
    // Race each step against a hard timeout — `rehydrateFromDb` and
    // `loadPaneTree` both hit tauri-plugin-sql's Database.load, which has
    // been observed to silently never resolve. Without this fence the
    // persist subscriber would never attach and pane state would not save.
    const raceTimeout = <T,>(p: Promise<T>, ms: number, label: string): Promise<T | null> =>
      new Promise((resolve) => {
        let done = false;
        const t = setTimeout(() => {
          if (done) return;
          done = true;
          // eslint-disable-next-line no-console
          console.warn(`[workspace] ${label} timed out after ${ms}ms`);
          resolve(null);
        }, ms);
        p.then(
          (v) => { if (done) return; done = true; clearTimeout(t); resolve(v); },
          (err) => { if (done) return; done = true; clearTimeout(t); console.warn(`[workspace] ${label} failed`, err); resolve(null); },
        );
      });
    void (async () => {
      if (!useTerminalStore.getState().rehydrated) {
        await raceTimeout(
          useTerminalStore.getState().rehydrateFromDb(),
          2000,
          'terminal rehydrate',
        );
      }
      if (cancelled) return;
      const snapshot = await raceTimeout(loadPaneTree(), 2000, 'loadPaneTree');
      if (cancelled) return;
      if (snapshot) usePaneStore.getState().hydrate(snapshot);
      unsubPersist = usePaneStore.subscribe((state) => {
        persistPaneTree({
          root: state.root,
          focusedId: state.focusedId,
          closedHistory: state.closedHistory,
        });
      });
    })();
    return () => {
      cancelled = true;
      if (unsubPersist) unsubPersist();
    };
  }, []);

  // Keyboard map (workspace-level). See Phase 12 spec § Keybinding history
  // for the rationale behind ⌘W / ⌘T moving from PR-A bindings.
  //   ⌘B           → toggle nav rail
  //   ⌘\           → split focused pane right
  //   ⌘⇧\          → split focused pane down
  //   ⌘W           → close focused PANE
  //   ⌘⇧W          → close active tab
  //   ⌘T           → command palette (views mode)
  //   ⌘⇧T          → reopen last-closed view (depth 10)
  //   ⌘P           → command palette (quick switcher)
  //   ⌃T           → new bash terminal in focused pane
  //   ⌃⇧T          → new claude terminal in focused pane
  //   ⌃1 .. ⌃6     → focus pane N (DFS leaf order)
  //
  // On non-Mac platforms there's no Cmd key, so `mod` matches Ctrl. That
  // means ⌃T (terminal) and ⌘T (palette) collide on Linux/Win; the
  // ctrlOnly branch fires first and "new bash terminal" wins. Use ⌘K to
  // open the palette in "all" mode on those platforms — same end result.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null;
      const inEditable = !!target?.matches('input, textarea, [contenteditable="true"]');
      const mod = e.metaKey || e.ctrlKey;
      const ctrlOnly = e.ctrlKey && !e.metaKey;

      if (mod && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'b') {
        e.preventDefault();
        setNavHidden((v) => !v);
        return;
      }
      if (mod && !e.altKey && e.key === '\\') {
        e.preventDefault();
        usePaneStore
          .getState()
          .splitFocused(e.shiftKey ? 'vertical' : 'horizontal');
        return;
      }
      if (e.key.toLowerCase() === 't' && !inEditable) {
        // ⌃T / ⌃⇧T → new terminal (matches ctrlOnly first so Linux Ctrl-T
        // still creates a terminal even though `mod` would match too).
        if (ctrlOnly && !e.altKey) {
          e.preventDefault();
          const sessionId = e.shiftKey
            ? createTerminalSession({ cmd: ['claude'], title: 'claude' })
            : createTerminalSession();
          const focusedId = usePaneStore.getState().focusedId;
          usePaneStore
            .getState()
            .addTab(focusedId, { kind: 'terminal', sessionId });
          return;
        }
        // ⌘T → palette views; ⌘⇧T → reopen.
        if (mod && !e.altKey) {
          e.preventDefault();
          if (e.shiftKey) {
            usePaneStore.getState().reopenLastClosed();
          } else {
            palette.setOpen(true, 'views');
          }
          return;
        }
      }
      if (mod && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'p' && !inEditable) {
        e.preventDefault();
        palette.setOpen(true, 'switcher');
        return;
      }
      // Don't intercept ⌘W while typing.
      if (mod && !e.altKey && e.key.toLowerCase() === 'w' && !inEditable) {
        e.preventDefault();
        if (e.shiftKey) {
          usePaneStore.getState().closeActiveTab();
        } else {
          usePaneStore.getState().closeFocusedPane();
        }
        return;
      }
      if (ctrlOnly && !e.shiftKey && !e.altKey && /^[1-6]$/.test(e.key)) {
        e.preventDefault();
        usePaneStore.getState().focusByIndex(parseInt(e.key, 10) - 1);
        return;
      }
      // ⌘J — cycle dock state (hidden → collapsed → expanded → wide).
      if (mod && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'j' && !inEditable) {
        e.preventDefault();
        useDockStore.getState().cycleState();
        return;
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [palette]);

  if (!initialSizes) {
    return (
      <div className="flex h-screen w-screen items-center justify-center bg-background text-sm text-muted-foreground">
        Loading workspace…
      </div>
    );
  }

  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-background text-foreground">
      <ConnectorBanner />
      <div className="flex min-h-0 flex-1">
        <ActivityBar />
        <PanelGroup
          direction="horizontal"
          className="flex-1"
          onLayout={(sizes) => persist(sizes)}
          autoSaveId="ikenga-workspace-v2"
        >
          {!navHidden && (
            <>
              <Panel
                defaultSize={initialSizes[0]}
                minSize={8}
                maxSize={30}
                collapsible
                collapsedSize={6}
              >
                <Sidebar />
              </Panel>
              <PanelResizeHandle data-panel-resize-handle-enabled="true" />
            </>
          )}

          <Panel defaultSize={navHidden ? 100 : initialSizes[1]} minSize={40}>
            <ContentPane />
          </Panel>
        </PanelGroup>

        <Dock />
      </div>

      <CommandPalette
        open={palette.open}
        mode={palette.mode}
        onOpenChange={(open) => palette.setOpen(open)}
      />
    </div>
  );
}
