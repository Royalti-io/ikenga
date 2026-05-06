// Layout-state persistence helpers for the workspace shell.
//
// Primary store: tauri-plugin-sql (sqlite:pa.db, `layout_state` kv).
// Fallback: window.localStorage. The fallback exists because Database.load
// has been observed to silently never resolve in some launches — the
// terminal session-store uses the same pattern. localStorage keys are
// namespaced under `__lstate__:` to avoid collision with other writers.
//
// On every save we always write to localStorage first (synchronous, never
// fails on the hot path) and best-effort upgrade to SQLite. On load, we
// prefer SQLite and fall through to localStorage on any error or timeout.
// Net result: state is durable even when the SQL plugin is misbehaving.

import Database from '@tauri-apps/plugin-sql';

const SQL_TIMEOUT_MS = 1500;
const LS_PREFIX = '__lstate__:';

let dbPromise: Promise<Database | null> | null = null;

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    p.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); },
    );
  });
}

/** Returns the SQL Database, or null if the plugin is unavailable / hung. */
function getDb(): Promise<Database | null> {
  if (!dbPromise) {
    dbPromise = withTimeout(
      Database.load('sqlite:pa.db'),
      SQL_TIMEOUT_MS,
      'Database.load(pa.db)',
    )
      .then<Database | null>((db) => db)
      .catch((err) => {
        // eslint-disable-next-line no-console
        console.warn('[layout-state] sqlite unavailable, using localStorage', err);
        // Cache null so we don't retry every call.
        return null;
      });
  }
  return dbPromise;
}

function lsRead<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(LS_PREFIX + key);
    return raw == null ? null : (JSON.parse(raw) as T);
  } catch {
    return null;
  }
}

function lsWrite(key: string, value: unknown): void {
  try {
    localStorage.setItem(LS_PREFIX + key, JSON.stringify(value));
  } catch {
    // quota / disabled — drop silently.
  }
}

export async function loadLayoutState<T>(key: string, fallback: T): Promise<T> {
  const db = await getDb();
  if (db) {
    try {
      const rows = (await withTimeout(
        db.select('SELECT value FROM layout_state WHERE key = ? LIMIT 1', [key]),
        SQL_TIMEOUT_MS,
        'sqlite SELECT',
      )) as Array<{ value: string }>;
      if (rows.length > 0) return JSON.parse(rows[0].value) as T;
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[layout-state] load via sqlite failed, falling back to localStorage', { key, err });
    }
  }
  const ls = lsRead<T>(key);
  return ls ?? fallback;
}

export async function saveLayoutState(key: string, value: unknown): Promise<void> {
  // Always persist to localStorage first — synchronous, can't hang.
  lsWrite(key, value);
  const db = await getDb();
  if (!db) return;
  try {
    await withTimeout(
      db.execute(
        'INSERT INTO layout_state (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
        [key, JSON.stringify(value), Date.now()],
      ),
      SQL_TIMEOUT_MS,
      'sqlite INSERT',
    );
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[layout-state] save via sqlite failed (kept in localStorage)', { key, err });
  }
}

/** Tiny debounce — avoids pulling in lodash for this single use. */
export function debounce<A extends unknown[]>(
  fn: (...args: A) => void,
  delay: number
): (...args: A) => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return (...args: A) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => fn(...args), delay);
  };
}
