// Install panel — port of design/concepts/03-screens/12-install.html.
//
// Three rows always visible (no wizard hiding context):
//   1. Discover — source tabs (Catalog / Local / Git) + catalog grid
//   2. Inspect  — identity + declared blocks (left) · permissions table (right)
//   3. Act      — settings overrides (left) · handoff card with the same
//                 "Open in Chat" / "Copy Prompt" actions as v1 (right)
//
// Both handoff buttons emit the SAME prompt — see lib/install/prompt.ts.

import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { writeText } from '@tauri-apps/plugin-clipboard-manager';
import { useEffect, useMemo, useState } from 'react';

import { buildInstallPrompt, type InstallSource } from '@/lib/install/prompt';
import {
  claudeChatSpawn,
  iykeEndpoint,
  pkgInstallFromPath,
  pkgPreviewManifest,
  type PkgManifestPreview,
  type PkgSettingsField,
} from '@/lib/tauri-cmd';
import './install.css';

export const Route = createFileRoute('/install')({
  component: InstallPanel,
});

interface CatalogEntry {
  id: string;
  name: string;
  version: string;
  summary: string;
  source: { kind: 'local'; path: string } | { kind: 'git'; url: string; ref?: string };
  tags?: string[];
}
interface Catalog {
  version: number;
  packages: CatalogEntry[];
}

type SourceKind = 'catalog' | 'local' | 'git';

const PROJECT_DIR = '/home/nedjamez/royalti-co/ikenga-desktop';

function InstallPanel() {
  const navigate = useNavigate();
  const [sourceKind, setSourceKind] = useState<SourceKind>('catalog');
  const [localPath, setLocalPath] = useState('');
  const [gitUrl, setGitUrl] = useState('');
  const [gitRef, setGitRef] = useState('');
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [catalogChoice, setCatalogChoice] = useState<string>('');
  const [manifest, setManifest] = useState<PkgManifestPreview | null>(null);
  const [manifestError, setManifestError] = useState<string | null>(null);
  const [settingsOverrides, setSettingsOverrides] = useState<Record<string, string>>({});
  const [showSecrets, setShowSecrets] = useState<Record<string, boolean>>({});
  const [iyke, setIyke] = useState<{ url: string; token: string } | null>(null);
  const [busy, setBusy] = useState<'spawn' | 'copy' | 'install' | null>(null);
  const [flash, setFlash] = useState<{ kind: 'ok' | 'error'; msg: string } | null>(null);
  const [promptOpen, setPromptOpen] = useState(false);

  useEffect(() => {
    fetch('/install-catalog.json')
      .then((r) => r.json() as Promise<Catalog>)
      .then(setCatalog)
      .catch((e) => console.warn('[install] catalog load failed', e));
    iykeEndpoint().then(setIyke).catch((e) => console.warn('[install] iyke endpoint', e));
  }, []);

  const resolvedSource: InstallSource | null = useMemo(() => {
    if (sourceKind === 'local') {
      return localPath.trim() ? { kind: 'local', path: localPath.trim() } : null;
    }
    if (sourceKind === 'git') {
      return gitUrl.trim()
        ? { kind: 'git', url: gitUrl.trim(), ref: gitRef.trim() || undefined }
        : null;
    }
    const entry = catalog?.packages.find((p) => p.id === catalogChoice);
    return entry
      ? { kind: 'catalog', entry: { id: entry.id, name: entry.name, source: entry.source } }
      : null;
  }, [sourceKind, localPath, gitUrl, gitRef, catalog, catalogChoice]);

  // Read manifest when local source resolves; catalog entries with a local
  // source also get previewed so the user sees real schema + permissions.
  useEffect(() => {
    setManifestError(null);
    if (!resolvedSource) {
      setManifest(null);
      return;
    }
    let pathToRead: string | null = null;
    if (resolvedSource.kind === 'local') pathToRead = resolvedSource.path;
    else if (resolvedSource.kind === 'catalog' && resolvedSource.entry.source.kind === 'local') {
      pathToRead = resolvedSource.entry.source.path;
    }
    if (!pathToRead) {
      setManifest(null);
      return;
    }
    let cancelled = false;
    pkgPreviewManifest(pathToRead)
      .then((m) => {
        if (!cancelled) setManifest(m);
      })
      .catch((e) => {
        if (!cancelled) {
          setManifest(null);
          setManifestError((e as Error).message ?? String(e));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [resolvedSource]);

  const overridesAsJson = useMemo(() => {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(settingsOverrides)) {
      try {
        out[k] = JSON.parse(v);
      } catch {
        out[k] = v;
      }
    }
    return out;
  }, [settingsOverrides]);

  const prompt = useMemo(() => {
    if (!resolvedSource || !iyke) return '';
    return buildInstallPrompt({
      source: resolvedSource,
      manifest,
      settingsOverrides: overridesAsJson,
      iyke,
    });
  }, [resolvedSource, manifest, overridesAsJson, iyke]);

  const onCopy = async () => {
    if (!prompt) return;
    setBusy('copy');
    try {
      await writeText(prompt);
      setFlash({ kind: 'ok', msg: 'Copied install prompt to clipboard.' });
    } catch (e) {
      setFlash({ kind: 'error', msg: `Copy failed: ${(e as Error).message ?? String(e)}` });
    } finally {
      setBusy(null);
    }
  };

  const installablePath = useMemo(() => {
    if (!resolvedSource) return null;
    if (resolvedSource.kind === 'local') return resolvedSource.path;
    if (resolvedSource.kind === 'catalog' && resolvedSource.entry.source.kind === 'local') {
      return resolvedSource.entry.source.path;
    }
    return null;
  }, [resolvedSource]);

  const onInstallNow = async () => {
    if (!installablePath) return;
    setBusy('install');
    try {
      const r = await pkgInstallFromPath(installablePath);
      setFlash({
        kind: 'ok',
        msg: `Installed ${r.installed.id}@${r.installed.version}.`,
      });
    } catch (e) {
      setFlash({ kind: 'error', msg: `Install failed: ${(e as Error).message ?? String(e)}` });
    } finally {
      setBusy(null);
    }
  };

  const onOpenInChat = async () => {
    if (!prompt) return;
    setBusy('spawn');
    try {
      const r = await claudeChatSpawn(PROJECT_DIR, { prompt, permissionMode: 'auto' });
      navigate({ to: '/sessions/$sessionId', params: { sessionId: r.sessionId } });
    } catch (e) {
      setFlash({ kind: 'error', msg: `Spawn failed: ${(e as Error).message ?? String(e)}` });
      setBusy(null);
    }
  };

  const settingsSchema = manifest?.settings?.schema ?? [];
  const declaredBlocks = useMemo(() => describeBlocks(manifest), [manifest]);
  const permRows = useMemo(() => describePermissions(manifest), [manifest]);

  return (
    <div className="inst-page">
      <header className="inst-header">
        <div className="inst-header-row">
          <BoxIcon className="inst-header-mark" />
          <h1 className="inst-header-title">
            Install · <em>package manager</em>
          </h1>
        </div>
        <div className="inst-header-sub">
          Pick a source, scan the manifest, adjust settings, then hand the install off to Claude.
          The kernel registers the deterministic record · 8 registries · ikenga_api v
          {manifest?.ikenga_api ?? '1'}.
        </div>
      </header>

      <div className="inst-page-body">
        {/* ===== ROW 1 · DISCOVER ===== */}
        <RowRule num={1} label="Discover · pick a source" />

        <div className="inst-row">
          <div className="inst-source-tabs" role="tablist">
            <button
              type="button"
              role="tab"
              aria-selected={sourceKind === 'catalog'}
              className={cls('inst-source-tab', sourceKind === 'catalog' && 'is-on')}
              onClick={() => setSourceKind('catalog')}
            >
              <GridIcon /> Catalog
              {catalog?.packages.length ? (
                <span className="inst-source-tab-count">{catalog.packages.length}</span>
              ) : null}
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={sourceKind === 'local'}
              className={cls('inst-source-tab', sourceKind === 'local' && 'is-on')}
              onClick={() => setSourceKind('local')}
            >
              <FolderIcon /> Local Path
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={sourceKind === 'git'}
              className={cls('inst-source-tab', sourceKind === 'git' && 'is-on')}
              onClick={() => setSourceKind('git')}
            >
              <GitIcon /> Git URL
            </button>
            {resolvedSource ? (
              <span className="inst-source-selected">
                Selected · {describeSelected(resolvedSource, manifest)}
              </span>
            ) : null}
          </div>

          <div className="inst-source-pane">
            {sourceKind === 'catalog' && (
              <CatalogGrid
                catalog={catalog}
                value={catalogChoice}
                onChange={setCatalogChoice}
              />
            )}
            {sourceKind === 'local' && (
              <div className="inst-src-form">
                <div className="inst-field">
                  <div className="inst-field-label-row">
                    <span className="inst-field-label">Absolute path</span>
                    <span className="inst-field-key">resolves manifest immediately</span>
                  </div>
                  <div className="inst-input-group">
                    <span className="inst-input-addon">
                      <FolderIcon />
                    </span>
                    <input
                      className="inst-input"
                      placeholder="/absolute/path/to/package-dir"
                      value={localPath}
                      onChange={(e) => setLocalPath(e.target.value)}
                      spellCheck={false}
                    />
                  </div>
                </div>
              </div>
            )}
            {sourceKind === 'git' && (
              <div className="inst-src-form">
                <div className="inst-field-row">
                  <div className="inst-field">
                    <div className="inst-field-label-row">
                      <span className="inst-field-label">Repository URL</span>
                      <span className="inst-field-key">https / ssh</span>
                    </div>
                    <input
                      className="inst-input"
                      placeholder="https://github.com/owner/repo.git"
                      value={gitUrl}
                      onChange={(e) => setGitUrl(e.target.value)}
                      spellCheck={false}
                    />
                  </div>
                  <div className="inst-field">
                    <div className="inst-field-label-row">
                      <span className="inst-field-label">Ref</span>
                      <span className="inst-field-key">branch · tag</span>
                    </div>
                    <input
                      className="inst-input"
                      placeholder="main"
                      value={gitRef}
                      onChange={(e) => setGitRef(e.target.value)}
                      spellCheck={false}
                    />
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* ===== ROW 2 · INSPECT ===== */}
        <RowRule num={2} label="Inspect · what the kernel will register" />

        <div className="inst-row inst-inspect-grid">
          <div className="inst-inspect-left">
            {manifestError ? (
              <pre className="inst-error-pre">{manifestError}</pre>
            ) : !manifest ? (
              <div className="inst-loading">
                {resolvedSource?.kind === 'git'
                  ? 'Manifest will be read after Claude clones the repo.'
                  : resolvedSource
                    ? 'Reading manifest…'
                    : 'No source picked yet — pick one above to preview.'}
              </div>
            ) : (
              <>
                <div className="inst-ident">
                  <h3 className="inst-ident-name">{manifest.name}</h3>
                  <div className="inst-ident-id">
                    <span>{manifest.id}</span>
                    <span className="ver">v{manifest.version}</span>
                    <span className="api">ikenga_api · {manifest.ikenga_api}</span>
                  </div>
                  {manifest.author ? (
                    <div className="inst-ident-author">
                      Author · {(manifest.author as { name?: string }).name ?? '—'}
                      {(manifest.author as { key?: string }).key ? (
                        <span className="inst-ident-keychip">
                          key · {(manifest.author as { key: string }).key}
                        </span>
                      ) : null}
                    </div>
                  ) : null}
                </div>

                <div>
                  <div className="inst-blocks-label">
                    Declared blocks
                    <span className="sub">
                      · {declaredBlocks.length} of 8 registries touched
                    </span>
                  </div>
                  {declaredBlocks.length ? (
                    <div className="inst-blocks-stack">
                      {declaredBlocks.map((b) => (
                        <div
                          key={b.kind}
                          className={cls('inst-block-row', `is-${b.kind}`)}
                        >
                          <span className="icon">{b.icon}</span>
                          <span className="name">
                            {b.kind}
                            {b.detail ? <span className="sub">· {b.detail}</span> : null}
                          </span>
                          <span className="ct">{b.count ?? '—'}</span>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="inst-loading">No blocks declared.</div>
                  )}
                </div>
              </>
            )}
          </div>

          <div className="vrule" />

          <div className="inst-inspect-right">
            {!manifest ? (
              <div className="inst-loading">Permissions appear once the manifest is read.</div>
            ) : permRows.length === 0 ? (
              <div className="inst-perm-empty">
                <CheckIcon className="horn" />
                <p>
                  <strong>No scopes requested.</strong>
                </p>
                <p>
                  Skill-only package — no fs/net/shell access. The kernel still records the
                  install with an empty <code>permissions</code> block.{' '}
                  <em>Intentional · not a bug.</em>
                </p>
              </div>
            ) : (
              <>
                <PermSummary rows={permRows} />
                <div className="inst-perm-table">
                  <div className="inst-perm-row inst-perm-head">
                    <span>Scope</span>
                    <span>Verb</span>
                    <span>Pattern</span>
                    <span style={{ textAlign: 'right' }}>Risk</span>
                  </div>
                  {permRows.map((r, i) => (
                    <div key={`${r.scope}-${i}`} className="inst-perm-row">
                      <span className={cls('scope', `is-${r.scopeClass}`)}>{r.scope}</span>
                      <span className={cls('verb', r.verbClass)}>{r.verb}</span>
                      <span className="glob" title={r.glob}>
                        {r.glob}
                      </span>
                      <RiskCell level={r.risk} title={r.riskHint} />
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
        </div>

        {/* ===== ROW 3 · ACT ===== */}
        <RowRule num={3} label="Act · adjust settings · hand off to Claude" />

        <div className="inst-row inst-act-grid">
          <div className="inst-act-left">
            <div className="inst-blocks-label">
              Settings
              {settingsSchema.length ? (
                <span className="sub">
                  · {settingsSchema.length} field{settingsSchema.length === 1 ? '' : 's'} declared
                </span>
              ) : (
                <span className="sub">· no settings schema declared</span>
              )}
            </div>
            {settingsSchema.length === 0 ? (
              <div className="inst-loading">
                {manifest
                  ? 'This package has no settings — nothing to override.'
                  : 'Pick a source to see declared settings.'}
              </div>
            ) : (
              settingsSchema.map((f) => (
                <SettingsFieldRow
                  key={f.key}
                  field={f}
                  value={settingsOverrides[f.key]}
                  showSecret={showSecrets[f.key] ?? false}
                  onChange={(v) =>
                    setSettingsOverrides((p) => ({ ...p, [f.key]: v }))
                  }
                  onToggleSecret={() =>
                    setShowSecrets((p) => ({ ...p, [f.key]: !(p[f.key] ?? false) }))
                  }
                />
              ))
            )}
          </div>

          <div className="vrule" />

          <div className="inst-act-right">
            <div className="inst-handoff">
              <h3>
                Hand off to <em>Claude</em>
              </h3>
              <p>
                The kernel registers; Claude does the acquisition. Same prompt is used whether
                you open it in-app or paste it into a terminal.
              </p>

              <div className="inst-handoff-actions">
                <button
                  type="button"
                  className="inst-btn inst-btn-lg inst-btn-action"
                  disabled={!installablePath || busy !== null}
                  onClick={onInstallNow}
                  title={
                    installablePath
                      ? `Call pkg_install_from_path(${installablePath})`
                      : 'Install runs only for local / catalog-with-local sources'
                  }
                >
                  {busy === 'install' ? 'Installing…' : 'Install Now'}
                </button>
                <button
                  type="button"
                  className="inst-btn inst-btn-lg inst-btn-action"
                  disabled={!prompt || busy !== null}
                  onClick={onOpenInChat}
                >
                  <ChatIcon /> {busy === 'spawn' ? 'Opening…' : 'Open in Chat'}
                </button>
                <button
                  type="button"
                  className="inst-btn inst-btn-lg inst-btn-oxblood"
                  disabled={!prompt || busy !== null}
                  onClick={onCopy}
                >
                  <CopyIcon /> {busy === 'copy' ? 'Copying…' : 'Copy Prompt'}
                </button>
              </div>

              {prompt ? (
                <>
                  <button
                    type="button"
                    className="inst-prompt-toggle"
                    aria-expanded={promptOpen}
                    onClick={() => setPromptOpen((v) => !v)}
                  >
                    <ChevronIcon className="arrow" />
                    {promptOpen ? 'Hide' : 'Show'} generated prompt · {prompt.length} chars
                  </button>
                  {promptOpen ? (
                    <div className="inst-prompt-box">
                      <pre className="inst-prompt-pre">{prompt}</pre>
                    </div>
                  ) : null}
                </>
              ) : null}

              {flash ? (
                <div className={cls('inst-flash', flash.kind === 'error' && 'is-error')}>
                  {flash.msg}
                </div>
              ) : null}

              <div className="inst-handoff-meta">
                <span>Same prompt for both buttons · keeps installs reproducible.</span>
                {iyke ? (
                  <span className="inst-iyke-badge" title={iyke.url}>
                    <span className="dot" />
                    iyke · {shortHost(iyke.url)} · {iyke.token.slice(0, 10)}…
                  </span>
                ) : (
                  <span className="inst-iyke-badge" style={{ opacity: 0.6 }}>
                    iyke · waiting…
                  </span>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ============================================================
   Catalog grid
   ============================================================ */
function CatalogGrid(props: {
  catalog: Catalog | null;
  value: string;
  onChange: (id: string) => void;
}) {
  if (!props.catalog) {
    return <div className="inst-loading">Loading catalog…</div>;
  }
  if (!props.catalog.packages.length) {
    return <div className="inst-cat-empty">Catalog is empty.</div>;
  }
  return (
    <div className="inst-cat-grid">
      {props.catalog.packages.map((p) => {
        const selected = props.value === p.id;
        return (
          <button
            type="button"
            key={p.id}
            className={cls('inst-cat-card', selected && 'is-on')}
            onClick={() => props.onChange(p.id)}
          >
            <div className="inst-cat-id">
              {p.id} <span className="ver">v{p.version}</span>
            </div>
            <h3 className="inst-cat-name">{p.name}</h3>
            <div className="inst-cat-summary">{p.summary}</div>
            <div className="inst-cat-foot">
              <span className="inst-cat-source" title={describeCatalogSource(p.source)}>
                {describeCatalogSource(p.source)}
              </span>
              <div className="inst-cat-tags">
                {(p.tags ?? []).slice(0, 3).map((t) => (
                  <span key={t} className="inst-cat-tag">
                    {t}
                  </span>
                ))}
              </div>
            </div>
          </button>
        );
      })}
    </div>
  );
}

/* ============================================================
   Settings field
   ============================================================ */
function SettingsFieldRow(props: {
  field: PkgSettingsField;
  value: string | undefined;
  showSecret: boolean;
  onChange: (raw: string) => void;
  onToggleSecret: () => void;
}) {
  const { field: f, value, showSecret, onChange, onToggleSecret } = props;
  const defaultStr = stringifyDefault(f.default);
  const raw = value ?? '';
  const isBool = f.type === 'boolean';
  const isSecret = f.type === 'secret';
  const isNumber = f.type === 'number';
  const typeClass = isSecret ? 'is-secret' : isBool ? 'is-bool' : isNumber ? 'is-number' : '';

  // For booleans the toggle is the input; we serialize "true"/"false" as raw.
  const boolOn = isBool ? rawIsTrue(raw, f.default) : false;

  return (
    <div className="inst-field">
      <div className="inst-field-label-row">
        <span className="inst-field-label">{f.label}</span>
        <span className="inst-field-key">
          {f.key}
          <span className={cls('type', typeClass)}>{f.type}</span>
        </span>
      </div>

      {isBool ? (
        <button
          type="button"
          className={cls('inst-toggle', boolOn && 'is-on')}
          onClick={() => onChange(boolOn ? 'false' : 'true')}
        >
          <span className="switch" />
          <span>{boolOn ? 'Enabled' : 'Disabled'}</span>
        </button>
      ) : isSecret ? (
        <div className="inst-input-group">
          <input
            className={cls('inst-input', !raw && 'ghost')}
            type={showSecret ? 'text' : 'password'}
            value={raw}
            placeholder={defaultStr || '••••••••'}
            onChange={(e) => onChange(e.target.value)}
            spellCheck={false}
            autoComplete="off"
          />
          <button
            type="button"
            className="inst-input-addon-btn"
            onClick={onToggleSecret}
            aria-label={showSecret ? 'Hide secret' : 'Show secret'}
            title={showSecret ? 'Hide' : 'Show'}
          >
            {showSecret ? <EyeOffIcon /> : <EyeIcon />}
          </button>
        </div>
      ) : (
        <input
          className={cls('inst-input', !raw && 'ghost')}
          type="text"
          inputMode={isNumber ? 'decimal' : undefined}
          value={raw}
          placeholder={defaultStr}
          onChange={(e) => onChange(e.target.value)}
          spellCheck={false}
        />
      )}

      {f.description ? (
        <span className="inst-field-help">{f.description}</span>
      ) : defaultStr && !isBool ? (
        <span className="inst-field-help">
          Default: <code>{defaultStr}</code>
        </span>
      ) : null}
    </div>
  );
}

/* ============================================================
   Manifest → declared-blocks rows
   ============================================================ */
interface BlockRow {
  kind: 'sidecar' | 'cron' | 'mcp' | 'ui' | 'skill' | 'iyke';
  detail: string;
  count: string;
  icon: React.ReactNode;
}

function describeBlocks(m: PkgManifestPreview | null): BlockRow[] {
  if (!m) return [];
  const out: BlockRow[] = [];
  if (m.sidecars?.length) {
    out.push({
      kind: 'sidecar',
      detail: m.sidecars.map((s) => s.name).join(', '),
      count: `${m.sidecars.length} sidecar${m.sidecars.length === 1 ? '' : 's'}`,
      icon: <SidecarIcon />,
    });
  }
  if (m.cron?.length) {
    out.push({
      kind: 'cron',
      detail: m.cron.map((c) => `${c.id} (${c.expr})`).join(', '),
      count: `${m.cron.length} cron`,
      icon: <ClockIcon />,
    });
  }
  if (m.mcp?.length) {
    out.push({
      kind: 'mcp',
      detail: m.mcp.map((s) => s.name).join(', '),
      count: `${m.mcp.length} mcp`,
      icon: <McpIcon />,
    });
  }
  if (m.ui?.routes?.length) {
    out.push({
      kind: 'ui',
      detail: m.ui.routes.map((r) => `${r.kind}:${r.path}`).join(', '),
      count: `${m.ui.routes.length} route${m.ui.routes.length === 1 ? '' : 's'}`,
      icon: <RouteIcon />,
    });
  }
  if (m.skills) {
    out.push({
      kind: 'skill',
      detail: m.skills,
      count: 'skills',
      icon: <SkillIcon />,
    });
  }
  // Surface iyke routes if the manifest declares them. Cast through unknown
  // because PkgManifestPreview has an [k: string] index — TS otherwise widens.
  const iyke = (m as Record<string, unknown>).iyke as
    | { routes?: Array<{ method: string; path: string }> }
    | undefined;
  if (iyke?.routes?.length) {
    out.push({
      kind: 'iyke',
      detail: iyke.routes.map((r) => `${r.method} ${r.path}`).join(', '),
      count: `${iyke.routes.length} route${iyke.routes.length === 1 ? '' : 's'}`,
      icon: <IykeIcon />,
    });
  }
  return out;
}

/* ============================================================
   Manifest → permission rows
   ============================================================ */
interface PermRow {
  scope: string;
  scopeClass: 'fs' | 'shell' | 'net' | 'supa' | 'vault';
  verb: string;
  verbClass: '' | 'read' | 'write' | 'exec';
  glob: string;
  risk: 'low' | 'med' | 'high';
  riskHint: string;
}

function describePermissions(m: PkgManifestPreview | null): PermRow[] {
  if (!m?.permissions) return [];
  const p = m.permissions as Record<string, unknown>;
  const rows: PermRow[] = [];
  for (const [k, v] of Object.entries(p)) {
    if (!Array.isArray(v) || v.length === 0) continue;
    for (const item of v) {
      const glob = typeof item === 'string' ? item : JSON.stringify(item);
      rows.push(rowForScope(k, glob));
    }
  }
  return rows;
}

function rowForScope(key: string, glob: string): PermRow {
  // Risk heuristic — wide-open globs and shell.execute → high; user-config
  // reads or specific net hosts → med; package-local paths → low.
  const wide = /\*\*$|^\$home\/?\*\*?$|^\/\*?$/.test(glob);
  switch (key) {
    case 'fs.read':
      return {
        scope: 'fs.read',
        scopeClass: 'fs',
        verb: 'read',
        verbClass: 'read',
        glob,
        risk: wide ? 'high' : /\$home/.test(glob) ? 'med' : 'low',
        riskHint: wide ? 'Wide-open read scope' : '',
      };
    case 'fs.write':
      return {
        scope: 'fs.write',
        scopeClass: 'fs',
        verb: 'write',
        verbClass: 'write',
        glob,
        risk: wide ? 'high' : /\$home/.test(glob) ? 'med' : 'low',
        riskHint: '',
      };
    case 'shell.execute':
      return {
        scope: 'shell.execute',
        scopeClass: 'shell',
        verb: 'exec',
        verbClass: 'exec',
        glob,
        risk: 'high',
        riskHint: 'Shell execution is always high risk',
      };
    case 'net':
      return {
        scope: 'net',
        scopeClass: 'net',
        verb: 'net',
        verbClass: '',
        glob,
        risk: /^https?:\/\/\*\b/.test(glob) ? 'high' : 'med',
        riskHint: '',
      };
    case 'supabase.tables':
      return {
        scope: 'supabase.tables',
        scopeClass: 'supa',
        verb: 'read',
        verbClass: 'read',
        glob,
        risk: glob === '*' ? 'high' : 'low',
        riskHint: '',
      };
    case 'vault.keys':
      return {
        scope: 'vault.keys',
        scopeClass: 'vault',
        verb: 'read',
        verbClass: '',
        glob,
        risk: 'med',
        riskHint: '',
      };
    default:
      return {
        scope: key,
        scopeClass: 'fs',
        verb: '',
        verbClass: '',
        glob,
        risk: 'med',
        riskHint: '',
      };
  }
}

function PermSummary(props: { rows: PermRow[] }) {
  const counts = props.rows.reduce<Record<string, number>>((acc, r) => {
    const key =
      r.scope === 'fs.read'
        ? 'reads'
        : r.scope === 'fs.write'
          ? 'writes'
          : r.scope === 'net'
            ? 'net hosts'
            : r.scope === 'shell.execute'
              ? 'shell scopes'
              : r.scope;
    acc[key] = (acc[key] ?? 0) + 1;
    return acc;
  }, {});
  const order = ['reads', 'writes', 'shell scopes', 'net hosts', 'supabase.tables', 'vault.keys'];
  const parts = order
    .filter((k) => counts[k])
    .map((k) => `${counts[k]} ${k}`);
  const hasShell = (counts['shell scopes'] ?? 0) > 0;
  return (
    <div className="inst-perm-summary">
      <HornIcon className="horn" />
      <span>
        This package wants <strong>{parts.join(', ')}</strong>.{' '}
        {hasShell ? (
          <strong>Shell execute requested · review carefully.</strong>
        ) : (
          <span>No shell.execute · trust is negotiated in the chat.</span>
        )}
      </span>
    </div>
  );
}

function RiskCell(props: { level: 'low' | 'med' | 'high'; title?: string }) {
  return (
    <span className={cls('inst-risk', props.level)} title={props.title || undefined}>
      <span className="inst-risk-bars">
        <span />
        <span />
        <span />
      </span>
      {props.level}
    </span>
  );
}

/* ============================================================
   Helpers
   ============================================================ */
function RowRule(props: { num: number; label: string }) {
  return (
    <div className="inst-row-rule">
      <span className="inst-row-rule-num">{props.num}.</span>
      {props.label}
      <svg
        className="carve"
        width="48"
        height="6"
        viewBox="0 0 48 6"
        aria-hidden="true"
      >
        <polygon points="0,3 6,0 12,3 6,6" fill="currentColor" />
        <polygon points="18,3 24,0 30,3 24,6" fill="currentColor" />
        <polygon points="36,3 42,0 48,3 42,6" fill="currentColor" />
      </svg>
    </div>
  );
}

function describeCatalogSource(s: CatalogEntry['source']): string {
  return s.kind === 'local' ? s.path : s.url + (s.ref ? `#${s.ref}` : '');
}
function describeSelected(s: InstallSource, m: PkgManifestPreview | null): string {
  if (s.kind === 'local') return s.path;
  if (s.kind === 'git') return s.url + (s.ref ? `#${s.ref}` : '');
  return `${s.entry.id}${m ? ` v${m.version}` : ''}`;
}
function shortHost(url: string): string {
  try {
    const u = new URL(url);
    return u.host;
  } catch {
    return url;
  }
}
function rawIsTrue(raw: string, def: unknown): boolean {
  if (raw === '') return def === true;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  return raw.toLowerCase() === 'true';
}
function stringifyDefault(d: unknown): string {
  if (d === undefined || d === null) return '';
  if (typeof d === 'string') return d;
  return JSON.stringify(d);
}
function cls(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}

/* ============================================================
   Icons (inline so we don't pull lucide for every glyph)
   ============================================================ */
type IProps = { className?: string };
function svgProps(p: IProps) {
  return {
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.8,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    width: 14,
    height: 14,
    'aria-hidden': true,
    className: p.className,
  };
}
function BoxIcon(p: IProps) {
  return (
    <svg {...svgProps(p)} width={18} height={18}>
      <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
      <polyline points="3.27 6.96 12 12.01 20.73 6.96" />
      <line x1="12" y1="22.08" x2="12" y2="12" />
    </svg>
  );
}
function GridIcon(p: IProps = {}) {
  return (
    <svg {...svgProps(p)}>
      <rect x="3" y="3" width="7" height="7" />
      <rect x="14" y="3" width="7" height="7" />
      <rect x="3" y="14" width="7" height="7" />
      <rect x="14" y="14" width="7" height="7" />
    </svg>
  );
}
function FolderIcon(p: IProps = {}) {
  return (
    <svg {...svgProps(p)}>
      <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
    </svg>
  );
}
function GitIcon(p: IProps = {}) {
  return (
    <svg {...svgProps(p)}>
      <circle cx="12" cy="12" r="4" />
      <line x1="4.93" y1="4.93" x2="9.17" y2="9.17" />
      <line x1="14.83" y1="14.83" x2="19.07" y2="19.07" />
      <line x1="14.83" y1="9.17" x2="19.07" y2="4.93" />
      <line x1="4.93" y1="19.07" x2="9.17" y2="14.83" />
    </svg>
  );
}
function ChatIcon(p: IProps = {}) {
  return (
    <svg {...svgProps(p)} width={16} height={16}>
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
    </svg>
  );
}
function CopyIcon(p: IProps = {}) {
  return (
    <svg {...svgProps(p)} width={16} height={16}>
      <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  );
}
function ChevronIcon(p: IProps = {}) {
  return (
    <svg {...svgProps(p)} width={10} height={10}>
      <polyline points="9 18 15 12 9 6" />
    </svg>
  );
}
function CheckIcon(p: IProps = {}) {
  return (
    <svg {...svgProps(p)}>
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}
function HornIcon(p: IProps = {}) {
  // Subtle ikenga horn glyph used as the permission-summary mark.
  return (
    <svg {...svgProps(p)} width={18} height={18}>
      <path d="M3 18c2-7 5-11 9-11s7 4 9 11" />
      <path d="M7 18c1-4 2-7 5-7s4 3 5 7" />
    </svg>
  );
}
function EyeIcon(p: IProps = {}) {
  return (
    <svg {...svgProps(p)}>
      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}
function EyeOffIcon(p: IProps = {}) {
  return (
    <svg {...svgProps(p)}>
      <path d="M17.94 17.94A10.06 10.06 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94" />
      <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19" />
      <line x1="1" y1="1" x2="23" y2="23" />
    </svg>
  );
}
function SidecarIcon(p: IProps = {}) {
  return (
    <svg {...svgProps(p)}>
      <rect x="3" y="4" width="18" height="6" rx="1" />
      <rect x="3" y="14" width="18" height="6" rx="1" />
    </svg>
  );
}
function ClockIcon(p: IProps = {}) {
  return (
    <svg {...svgProps(p)}>
      <circle cx="12" cy="12" r="9" />
      <polyline points="12 6 12 12 16 14" />
    </svg>
  );
}
function McpIcon(p: IProps = {}) {
  return (
    <svg {...svgProps(p)}>
      <polyline points="16 18 22 12 16 6" />
      <polyline points="8 6 2 12 8 18" />
    </svg>
  );
}
function RouteIcon(p: IProps = {}) {
  return (
    <svg {...svgProps(p)}>
      <circle cx="6" cy="19" r="3" />
      <circle cx="18" cy="5" r="3" />
      <path d="M6 16V8a4 4 0 0 1 4-4h4" />
      <path d="M18 8v8a4 4 0 0 1-4 4h-4" />
    </svg>
  );
}
function SkillIcon(p: IProps = {}) {
  return (
    <svg {...svgProps(p)}>
      <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
    </svg>
  );
}
function IykeIcon(p: IProps = {}) {
  return (
    <svg {...svgProps(p)}>
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18M12 3a15 15 0 0 1 0 18M12 3a15 15 0 0 0 0 18" />
    </svg>
  );
}
