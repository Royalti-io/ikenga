import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { EntityFilter } from './overview';

interface EntityState {
  entity: EntityFilter;
  setEntity: (e: EntityFilter) => void;
}

/**
 * Shared accounting entity filter (mirrors ikenga's EntitySwitcher).
 * Persisted to localStorage so the choice is sticky across tabs/restarts.
 */
export const useEntityStore = create<EntityState>()(
  persist(
    (set) => ({
      entity: 'all',
      setEntity: (entity) => set({ entity }),
    }),
    { name: 'accounting-entity' },
  ),
);
