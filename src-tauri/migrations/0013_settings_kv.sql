-- 0013_settings_kv.sql
-- Durable key-value store for user-facing settings (theme, telemetry consent,
-- selected agent, onboarding state blob, claude project roots, etc.).
--
-- Zustand's `persist` middleware already puts these in localStorage; this
-- table is the authoritative mirror so "Clear local data" doesn't silently
-- wipe preferences, and so a future cross-device sync can read from one
-- place. Frontend stores hydrate from this table at boot, then write-through
-- on every setter (see `useShellStore.hydrateSettingsFromRust`).

CREATE TABLE IF NOT EXISTS settings_kv (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,       -- JSON-encoded; type-checked in TS
  updated_at INTEGER NOT NULL     -- unix ms
);
