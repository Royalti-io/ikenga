// Smoke test for the com.royalti.tasks kernel package — first real-feature
// migration. Marker install: TanStack file-router still serves /tasks from
// src/routes/tasks/, but the kernel is the source of truth for which package
// owns the path, the supabase table, the query prefix, and the settings schema.
//
// Phases (?phase=...):
//   roundtrip (default) — install, verify all 4 registries fired, uninstall, verify cleanup
//   install             — install, leave persisted (test boot replay)
//   verify              — assert prior install is intact (no install/uninstall)
//   cleanup             — uninstall only
import { createFileRoute, Link, useSearch } from '@tanstack/react-router';
import { useEffect, useState } from 'react';

import { pkgInstallFromPath, pkgKernelStatus, pkgUninstall } from '@/lib/tauri-cmd';

type Phase = 'roundtrip' | 'install' | 'verify' | 'cleanup';

export const Route = createFileRoute('/tasks-pkg-smoke')({
  component: TasksPkgSmoke,
  validateSearch: (s: Record<string, unknown>): { phase?: Phase } => ({
    phase: (s.phase as Phase) || undefined,
  }),
});

const PKG_PATH = '/tmp/test-pkg-com.royalti.tasks';
const PKG_ID = 'com.royalti.tasks';

type Row = { label: string; outcome: string };

interface UiRoutesSnap {
  entries?: Array<{ pkg_id: string; path: string; kind: string; source: string }>;
}
interface SettingsSnap {
  entries?: Array<{ pkg_id: string; schema: Array<{ key: string }>; values: Record<string, unknown> }>;
}
interface QueriesSnap {
  by_pkg?: Record<string, string[]>;
  count?: number;
}

function TasksPkgSmoke() {
  const search = useSearch({ from: '/tasks-pkg-smoke' });
  const phase: Phase = search.phase ?? 'roundtrip';
  const [rows, setRows] = useState<Row[]>([]);
  const [verdict, setVerdict] = useState('RUNNING');

  useEffect(() => {
    let cancelled = false;
    const log = (label: string, outcome: string) => {
      if (cancelled) return;
      // eslint-disable-next-line no-console
      console.log(`[tasks-pkg-smoke] ${label}: ${outcome}`);
      setRows((p) => [...p, { label, outcome }]);
    };

    const checkStatus = async () => {
      const s = await pkgKernelStatus();
      const installed = s.installed.some((i) => i.id === PKG_ID);

      const ui = (s.registries.ui_routes ?? {}) as UiRoutesSnap;
      const declaredPaths = ['/tasks', '/tasks/', '/tasks/$taskId'];
      const ownEntries = (ui.entries ?? []).filter((e) => e.pkg_id === PKG_ID);
      const uiPathsOk = declaredPaths.every((p) =>
        ownEntries.some((e) => e.path === p),
      );

      const settings = (s.registries.settings ?? {}) as SettingsSnap;
      const ownSettings = (settings.entries ?? []).find((e) => e.pkg_id === PKG_ID);
      const settingsKeysOk = !!ownSettings &&
        ['default_status_filter', 'show_auto_closed', 'list_page_size'].every(
          (k) => ownSettings.schema.some((f) => f.key === k),
        );

      // Note: permissions["supabase.tables"] is declared in the manifest but
      // PermissionsRegistry only enforces fs.read|fs.write|shell.execute today
      // (see Gap 2 in 2026-05-04-tasks-kernel-migration.md). We deliberately
      // do NOT assert anything about the perms snapshot for this package —
      // the supabase declaration is advisory metadata, RLS is the real boundary.

      const queries = (s.registries.queries ?? {}) as QueriesSnap;
      const queriesOk =
        Array.isArray(queries.by_pkg?.[PKG_ID]) &&
        queries.by_pkg?.[PKG_ID].includes('tasks');

      return { installed, uiPathsOk, settingsKeysOk, queriesOk };
    };

    (async () => {
      log('PHASE', phase);

      if (phase === 'verify') {
        try {
          const r = await checkStatus();
          const ok = r.installed && r.uiPathsOk && r.settingsKeysOk && r.queriesOk;
          log('STATUS',
            `installed=${r.installed} ui_routes=${r.uiPathsOk} settings=${r.settingsKeysOk} queries=${r.queriesOk}`);
          if (!cancelled) setVerdict(ok ? 'VERDICT PASS' : 'VERDICT FAIL');
        } catch (e) {
          log('STATUS', `FAIL ${(e as Error).message ?? String(e)}`);
          if (!cancelled) setVerdict('VERDICT FAIL');
        }
        return;
      }

      if (phase === 'cleanup') {
        try {
          await pkgUninstall(PKG_ID);
          log('UNINSTALL', 'OK');
          if (!cancelled) setVerdict('VERDICT PASS');
        } catch (e) {
          log('UNINSTALL', `FAIL ${(e as Error).message ?? String(e)}`);
          if (!cancelled) setVerdict('VERDICT FAIL');
        }
        return;
      }

      // roundtrip / install: ensure clean slate
      try {
        await pkgUninstall(PKG_ID);
      } catch {
        // not installed — fine
      }

      let installed = false;
      try {
        const r = await pkgInstallFromPath(PKG_PATH);
        installed = true;
        log('INSTALL', `OK id=${r.installed.id} version=${r.installed.version}`);
      } catch (e) {
        log('INSTALL', `FAIL ${(e as Error).message ?? String(e)}`);
      }

      let statusOk = false;
      try {
        const r = await checkStatus();
        statusOk = r.installed && r.uiPathsOk && r.settingsKeysOk && r.queriesOk;
        log('STATUS',
          `installed=${r.installed} ui_routes=${r.uiPathsOk} settings=${r.settingsKeysOk} queries=${r.queriesOk}`);
      } catch (e) {
        log('STATUS', `FAIL ${(e as Error).message ?? String(e)}`);
      }

      if (phase === 'install') {
        const ok = installed && statusOk;
        if (!cancelled) {
          setVerdict(ok ? 'VERDICT PASS (left installed for boot replay)' : 'VERDICT FAIL');
        }
        log('DONE', ok ? 'PASS-leave-installed' : 'FAIL');
        return;
      }

      // Idempotency: re-installing the same path should be a no-op (kernel
      // treats same-path install of an already-installed pkg as boot replay).
      let reinstallOk = false;
      try {
        await pkgInstallFromPath(PKG_PATH);
        reinstallOk = true;
        log('REINSTALL', 'OK (idempotent)');
      } catch (e) {
        log('REINSTALL', `FAIL ${(e as Error).message ?? String(e)}`);
      }

      let uninstallOk = false;
      try {
        await pkgUninstall(PKG_ID);
        const r = await checkStatus();
        const queries = (((await pkgKernelStatus()).registries.queries ?? {}) as QueriesSnap);
        const queryGone = !queries.by_pkg || !(PKG_ID in queries.by_pkg);
        uninstallOk = !r.installed && queryGone;
        log('UNINSTALL', `pkg_gone=${!r.installed} query_prefix_gone=${queryGone}`);
      } catch (e) {
        log('UNINSTALL', `FAIL ${(e as Error).message ?? String(e)}`);
      }

      const ok = installed && statusOk && reinstallOk && uninstallOk;
      const v = ok ? 'VERDICT PASS' : 'VERDICT FAIL';
      log('DONE', v);
      if (!cancelled) setVerdict(v);
    })();

    return () => {
      cancelled = true;
    };
  }, [phase]);

  return (
    <div style={{ padding: 24, fontFamily: 'monospace', fontSize: 13 }}>
      <h1 style={{ fontSize: 16, marginBottom: 12 }}>Smoke: com.royalti.tasks</h1>
      <div style={{ marginBottom: 8, fontSize: 12, opacity: 0.7 }}>
        Marker install: <Link to="/tasks">/tasks</Link> still served by file-router.
        Phases: <code>?phase=install|verify|cleanup</code> or default roundtrip.
      </div>
      <div data-testid="tasks-pkg-smoke-verdict" style={{ marginBottom: 16, fontWeight: 'bold' }}>
        {verdict}
      </div>
      <ul style={{ listStyle: 'none', padding: 0 }}>
        {rows.map((r, i) => (
          <li key={i} data-testid={`tasks-pkg-smoke-row-${r.label}`}>
            <strong>{r.label}</strong> — {r.outcome}
          </li>
        ))}
      </ul>
    </div>
  );
}
