import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { confirm as confirmDialog } from '@tauri-apps/plugin-dialog';
import { Box, CheckCircle2, ExternalLink, Loader2, Package, Power, Trash2, XCircle } from 'lucide-react';
import { useState } from 'react';

import {
  pkgKernelStatus,
  pkgPreviewManifest,
  pkgSetEnabled,
  pkgUninstall,
  type PkgInstalledSummary,
  type PkgManifestPreview,
} from '@/lib/tauri-cmd';
import { Button } from '@/components/ui/button';

interface PkgRow {
  installed: PkgInstalledSummary;
  manifest: PkgManifestPreview | null;
  manifestError: string | null;
}

function PackagesPage() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);

  const setEnabledMut = useMutation({
    mutationFn: ({ pkgId, enabled }: { pkgId: string; enabled: boolean }) =>
      pkgSetEnabled(pkgId, enabled),
    onSuccess: async () => {
      setError(null);
      await qc.refetchQueries({ queryKey: ['pkg'] });
    },
    onError: (e) => setError((e as Error).message ?? String(e)),
  });

  const uninstallMut = useMutation({
    mutationFn: (pkgId: string) => pkgUninstall(pkgId),
    onSuccess: async () => {
      setError(null);
      await qc.refetchQueries({ queryKey: ['pkg'] });
    },
    onError: (e) => setError((e as Error).message ?? String(e)),
  });

  const status = useQuery({
    queryKey: ['pkg', 'kernel-status'],
    queryFn: pkgKernelStatus,
    refetchOnWindowFocus: false,
  });

  const installPaths = (status.data?.installed ?? []).map((p) => p.install_path);
  // Manifests are content-addressable by install_path; only refetch when the
  // set of installed paths changes (install/uninstall), not on enable/disable.
  const manifests = useQuery({
    enabled: installPaths.length > 0,
    queryKey: ['pkg', 'manifests', installPaths.join('|')],
    staleTime: Infinity,
    queryFn: async (): Promise<Record<string, PkgManifestPreview | { _error: string }>> => {
      const out: Record<string, PkgManifestPreview | { _error: string }> = {};
      await Promise.all(
        installPaths.map(async (path) => {
          try {
            out[path] = await pkgPreviewManifest(path);
          } catch (e) {
            out[path] = { _error: (e as Error).message ?? String(e) };
          }
        }),
      );
      return out;
    },
  });

  const rows: PkgRow[] = (status.data?.installed ?? []).map((s) => {
    const m = manifests.data?.[s.install_path];
    const isError = m && '_error' in m;
    return {
      installed: s,
      manifest: m && !isError ? (m as PkgManifestPreview) : null,
      manifestError: isError ? (m as { _error: string })._error : null,
    };
  });
  const apiVersion = status.data?.api_version;

  return (
    <div className="flex h-full flex-col">
      <header className="border-b border-border px-6 py-4">
        <div className="flex items-center gap-2">
          <Package className="h-5 w-5 text-muted-foreground" />
          <h1 className="text-lg font-semibold">Packages</h1>
        </div>
        <p className="mt-1 text-xs text-muted-foreground">
          Installed pkgs running in the kernel
          {apiVersion ? ` (host ikenga_api v${apiVersion})` : ''}.
        </p>
      </header>

      <div className="flex-1 overflow-auto px-6 py-6">
        {status.isLoading && (
          <p className="text-xs text-muted-foreground">Loading kernel status…</p>
        )}
        {status.error && (
          <p className="text-xs text-red-700">
            Failed to read kernel status: {(status.error as Error).message}
          </p>
        )}
        {error && (
          <p className="mb-3 rounded border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700 dark:border-red-900/40 dark:bg-red-950/30 dark:text-red-300">
            {error}
          </p>
        )}
        {status.data && rows.length === 0 && !manifests.isLoading && (
          <p className="text-xs text-muted-foreground">No pkgs installed.</p>
        )}

        <div className="space-y-3">
          {rows.map((row) => {
            const busy =
              (setEnabledMut.isPending && setEnabledMut.variables?.pkgId === row.installed.id) ||
              (uninstallMut.isPending && uninstallMut.variables === row.installed.id);
            return (
              <PkgCard
                key={row.installed.id}
                row={row}
                busy={busy}
                onOpen={(path) => navigate({ to: path })}
                onToggle={() =>
                  setEnabledMut.mutate({
                    pkgId: row.installed.id,
                    enabled: !row.installed.enabled,
                  })
                }
                onUninstall={async () => {
                  const msg = `Uninstall ${row.manifest?.name ?? row.installed.id}? This drops the pkg row, settings, and granted permissions. The on-disk install path is left alone.`;
                  let ok = false;
                  try {
                    ok = await confirmDialog(msg, { title: 'Uninstall pkg', kind: 'warning' });
                  } catch {
                    ok = window.confirm(msg);
                  }
                  if (ok) uninstallMut.mutate(row.installed.id);
                }}
              />
            );
          })}
        </div>
      </div>
    </div>
  );
}

function PkgCard({
  row,
  busy,
  onOpen,
  onToggle,
  onUninstall,
}: {
  row: PkgRow;
  busy: boolean;
  onOpen: (path: string) => void;
  onToggle: () => void;
  onUninstall: () => void;
}) {
  const { installed, manifest, manifestError } = row;
  const enabled = installed.enabled;
  const compatible = installed.compatible;
  const tables =
    (manifest?.permissions?.['supabase.tables'] as string[] | undefined) ??
    (manifest?.permissions?.supabase as { tables?: string[] } | undefined)?.tables ??
    [];

  const installedAt = new Date(installed.installed_at);

  return (
    <div className="rounded-lg border border-border bg-background">
      <div className="flex items-start justify-between gap-3 border-b border-border px-4 py-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <Box className="h-4 w-4 shrink-0 text-muted-foreground" />
            <span className="truncate font-medium">{manifest?.name ?? installed.id}</span>
            <code className="truncate text-[11px] text-muted-foreground">{installed.id}</code>
          </div>
          <div className="mt-1 flex items-center gap-3 text-[11px] text-muted-foreground">
            <span>v{installed.version}</span>
            <span>·</span>
            <span>ikenga_api {installed.ikenga_api}</span>
            <span>·</span>
            <span>installed {installedAt.toLocaleDateString()}</span>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <StatusPill ok={enabled} okLabel="Enabled" badLabel="Disabled" />
          <StatusPill ok={compatible} okLabel="Compatible" badLabel="Incompatible" />
          <Button
            variant="outline"
            size="sm"
            className="h-7 gap-1 px-2 text-xs"
            onClick={onToggle}
            disabled={busy || !compatible}
            title={enabled ? 'Disable (tear down registries, keep row)' : 'Enable (register against the kernel)'}
          >
            {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Power className="h-3 w-3" />}
            {enabled ? 'Disable' : 'Enable'}
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="h-7 gap-1 px-2 text-xs text-red-700 hover:bg-red-50 dark:hover:bg-red-950/30"
            onClick={onUninstall}
            disabled={busy}
            title="Uninstall (drop the row, keep on-disk files)"
          >
            <Trash2 className="h-3 w-3" />
            Uninstall
          </Button>
        </div>
      </div>

      {manifestError && (
        <div className="border-b border-border px-4 py-2 text-[11px] text-red-700">
          Manifest unreadable: {manifestError}
        </div>
      )}

      {manifest?.ui?.routes && manifest.ui.routes.length > 0 && (
        <div className="px-4 py-3">
          <h3 className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            Routes
          </h3>
          <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-3 lg:grid-cols-4">
            {manifest.ui.routes.map((r) => (
              <Button
                key={r.path}
                variant="outline"
                size="sm"
                className="h-7 justify-between gap-2 px-2 text-xs"
                onClick={() => onOpen(r.path)}
                title={`Mount ${r.path} in the focused pane`}
              >
                <code className="truncate">{r.path}</code>
                <ExternalLink className="h-3 w-3 shrink-0" />
              </Button>
            ))}
          </div>
        </div>
      )}

      {tables.length > 0 && (
        <div className="border-t border-border px-4 py-3">
          <h3 className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            Supabase tables ({tables.length})
          </h3>
          <div className="flex flex-wrap gap-1">
            {tables.map((t) => (
              <code
                key={t}
                className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground"
              >
                {t}
              </code>
            ))}
          </div>
        </div>
      )}

      {(manifest?.sidecars?.length ?? 0) > 0 && (
        <div className="border-t border-border px-4 py-3">
          <h3 className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            Sidecars
          </h3>
          <div className="flex flex-wrap gap-1">
            {manifest!.sidecars!.map((s) => (
              <code
                key={s.name}
                className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground"
              >
                {s.name}
              </code>
            ))}
          </div>
        </div>
      )}

      <div className="border-t border-border px-4 py-2 font-mono text-[10px] text-muted-foreground">
        {installed.install_path}
      </div>
    </div>
  );
}

function StatusPill({
  ok,
  okLabel,
  badLabel,
}: {
  ok: boolean;
  okLabel: string;
  badLabel: string;
}) {
  const Icon = ok ? CheckCircle2 : XCircle;
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium ${
        ok
          ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/30 dark:text-emerald-300'
          : 'bg-red-50 text-red-700 dark:bg-red-950/30 dark:text-red-300'
      }`}
    >
      <Icon className="h-3 w-3" />
      {ok ? okLabel : badLabel}
    </span>
  );
}

export const Route = createFileRoute('/packages')({
  component: PackagesPage,
});
