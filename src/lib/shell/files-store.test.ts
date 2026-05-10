import { beforeEach, describe, expect, it, vi } from 'vitest';

// Stub layout-state so the store doesn't try to hit SQLite/localStorage in
// tests. We don't care about persistence here — the visibility-flag behavior
// can be exercised entirely in-memory.
vi.mock('@/lib/layout-state', () => ({
  loadLayoutState: vi.fn(async (_key: string, fallback: unknown) => fallback),
  saveLayoutState: vi.fn(async () => {}),
  // Run synchronously in tests so we don't have to await the debounce.
  debounce: <A extends unknown[]>(fn: (...args: A) => void) => fn,
}));

import { useFilesStore } from './files-store';

beforeEach(() => {
  // Reset to defaults — tests shouldn't leak state into each other.
  useFilesStore.setState({
    expanded: new Set<string>(),
    selectedPath: null,
    scrollTop: 0,
    showHidden: false,
    showIgnored: false,
    hydrated: false,
  });
});

describe('files-store visibility flags', () => {
  it('defaults both visibility flags to false', () => {
    const s = useFilesStore.getState();
    expect(s.showHidden).toBe(false);
    expect(s.showIgnored).toBe(false);
  });

  it('toggleShowHidden flips the flag', () => {
    const { toggleShowHidden } = useFilesStore.getState();
    toggleShowHidden();
    expect(useFilesStore.getState().showHidden).toBe(true);
    toggleShowHidden();
    expect(useFilesStore.getState().showHidden).toBe(false);
  });

  it('toggleShowIgnored flips the flag independently of showHidden', () => {
    const { toggleShowIgnored } = useFilesStore.getState();
    toggleShowIgnored();
    expect(useFilesStore.getState().showIgnored).toBe(true);
    expect(useFilesStore.getState().showHidden).toBe(false);
  });

  it('setShowHidden is idempotent — no-op if value matches current state', () => {
    const { setShowHidden } = useFilesStore.getState();
    setShowHidden(false); // already false
    expect(useFilesStore.getState().showHidden).toBe(false);
    setShowHidden(true);
    expect(useFilesStore.getState().showHidden).toBe(true);
    setShowHidden(true); // already true
    expect(useFilesStore.getState().showHidden).toBe(true);
  });

  it('hydrate populates flags from persisted snapshot', async () => {
    const layoutState = await import('@/lib/layout-state');
    (layoutState.loadLayoutState as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      expanded: ['/a'],
      selectedPath: '/a/file.ts',
      scrollTop: 42,
      showHidden: true,
      showIgnored: true,
    });

    await useFilesStore.getState().hydrate();
    const s = useFilesStore.getState();
    expect(s.showHidden).toBe(true);
    expect(s.showIgnored).toBe(true);
    expect(s.expanded.has('/a')).toBe(true);
    expect(s.scrollTop).toBe(42);
    expect(s.hydrated).toBe(true);
  });

  it('hydrate falls back to defaults when persisted snapshot lacks flags (older format)', async () => {
    const layoutState = await import('@/lib/layout-state');
    // Simulate a pre-v2 record without showHidden/showIgnored.
    (layoutState.loadLayoutState as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      expanded: [],
      selectedPath: null,
      scrollTop: 0,
    });

    await useFilesStore.getState().hydrate();
    const s = useFilesStore.getState();
    expect(s.showHidden).toBe(false);
    expect(s.showIgnored).toBe(false);
  });
});
