// HyperFrames pkg wrapper UI.
//
// Lives inside the iframe served by the com.royalti.hyperframes pkg's
// dist/index.html. PkgIframeHost mounts this document via srcdoc with a
// <base href> pointing at the pkg-content axum endpoint, sets up an
// AppBridge over postMessage, and pushes the McpUiHostContext (theme +
// CSS vars + royaltiAuth token) before listening for our `ui/initialize`.
//
// Scope (PR 3, per design doc 2026-05-04 §Q4):
//   • Project picker (calls list_projects).
//   • On select: open_project(slug) → embed <iframe src="http://127.0.0.1:<port>"> in the right pane.
//   • Switch between projects: close_project(prev) then open new.
//   • On unmount (page close, host detaches bridge): close all via list_active sweep.
//   • NO toolbar / annotations / agent panels — those land in PR ?+
//
// We expose `window.__hyperframes_state` and `window.__hyperframes_open(slug)`
// as a smoke surface so /iframe-mount-smoke?phase=hyperframes can drive the
// flow without synthesizing click events. Mirrors __iframeapp_state.

// View-side SDK: the wrapper runs inside the pkg iframe, so it's the "App"
// in MCP-apps terminology. The host (PkgIframeHost) is the bridge.
import { App, PostMessageTransport } from '@modelcontextprotocol/ext-apps';

interface ProjectListResult {
  projects?: unknown;
}

interface OpenProjectResult {
  port?: unknown;
  project?: unknown;
}

type Status = 'connecting' | 'connected' | 'error';

interface WrapperState {
  status: Status;
  error: string | null;
  projects: string[];
  currentSlug: string | null;
  port: number | null;
  previewLoaded: boolean;
}

declare global {
  interface Window {
    __hyperframes_state?: WrapperState;
    __hyperframes_open?: (slug: string) => Promise<void>;
    __hyperframes_close?: () => Promise<void>;
  }
}

const state: WrapperState = {
  status: 'connecting',
  error: null,
  projects: [],
  currentSlug: null,
  port: null,
  previewLoaded: false,
};

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} missing from DOM`);
  return el as T;
};

const statusEl = $('status');
const listEl = $<HTMLUListElement>('projects');
const emptyEl = $('empty');
const placeholderEl = $('placeholder');
const previewFrame = $<HTMLIFrameElement>('preview-frame');

function publishState(): void {
  // Shallow-clone so smoke assertions can't mutate our copy.
  window.__hyperframes_state = { ...state };
}

function setStatus(next: Status, err?: string): void {
  state.status = next;
  state.error = err ?? null;
  statusEl.dataset.state = next;
  statusEl.textContent = next === 'error' ? `error: ${err ?? '?'}` : next;
  publishState();
}

function renderProjects(): void {
  listEl.innerHTML = '';
  if (state.projects.length === 0) {
    emptyEl.hidden = false;
    return;
  }
  emptyEl.hidden = true;
  for (const slug of state.projects) {
    const li = document.createElement('li');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.role = 'option';
    btn.textContent = slug;
    btn.dataset.slug = slug;
    btn.setAttribute('aria-selected', String(state.currentSlug === slug));
    btn.addEventListener('click', () => {
      void openSlug(slug);
    });
    li.appendChild(btn);
    listEl.appendChild(li);
  }
}

function setSelected(slug: string | null): void {
  for (const btn of listEl.querySelectorAll<HTMLButtonElement>('button[data-slug]')) {
    btn.setAttribute('aria-selected', String(btn.dataset.slug === slug));
  }
}

// Identity + capabilities the App reports to the bridge during handshake.
// `tools.listChanged: false` because this view doesn't expose any
// view-side tools — we only call into the MCP server (the sidecar).
const APP_INFO = { name: 'pa-hyperframes-wrapper', version: '0.2.0' };
const APP_CAPABILITIES = {
  tools: { listChanged: false },
} as const;

const app = new App(APP_INFO, APP_CAPABILITIES);
const transport = new PostMessageTransport(window.parent, window.parent);

async function callTool<T = Record<string, unknown>>(
  name: string,
  args: Record<string, unknown> = {},
): Promise<T> {
  const result = (await app.callServerTool({ name, arguments: args })) as
    | (Record<string, unknown> & { isError?: boolean; content?: unknown[] })
    | null;
  // The hyperframes sidecar puts structured fields at the top level of
  // the CallToolResult alongside `content[]` (see sidecar.ts:toolResult).
  // We return the whole result minus the MCP-protocol fields so callers
  // can read e.g. `r.projects` / `r.port` directly.
  if (result?.isError) {
    const text = Array.isArray(result.content)
      ? result.content
          .map((c) =>
            typeof c === 'object' && c && 'text' in c
              ? String((c as { text?: unknown }).text)
              : '',
          )
          .join('')
      : '';
    throw new Error(text || `${name} failed`);
  }
  return (result ?? {}) as T;
}

async function loadProjects(): Promise<void> {
  const r = await callTool<ProjectListResult>('list_projects');
  const projects = Array.isArray(r.projects)
    ? r.projects.filter((p): p is string => typeof p === 'string')
    : [];
  state.projects = projects;
  renderProjects();
  publishState();
}

async function openSlug(slug: string): Promise<void> {
  // Idempotent: clicking the same slug twice is a no-op the sidecar will
  // also accept (it returns the existing {project,port}). We still gate
  // here to avoid flicker on the preview iframe.
  if (state.currentSlug === slug && state.port !== null) return;

  // Switch projects: close the previous one to free its preview server.
  // Cap is 4 in the sidecar but we only ever surface one in PR 3, so we
  // close-then-open instead of letting them accumulate.
  if (state.currentSlug && state.currentSlug !== slug) {
    try {
      await callTool('close_project', { slug: state.currentSlug });
    } catch (err) {
      // Best-effort: a stale entry shouldn't block opening the new one.
      console.warn('[hyperframes-wrapper] close_project (prev) failed', err);
    }
  }

  setSelected(slug);
  placeholderEl.textContent = `Booting ${slug}…`;
  placeholderEl.hidden = false;
  previewFrame.hidden = true;
  previewFrame.src = 'about:blank';
  state.currentSlug = slug;
  state.port = null;
  state.previewLoaded = false;
  publishState();

  const r = await callTool<OpenProjectResult>('open_project', { slug });
  const port = typeof r.port === 'number' ? r.port : null;
  if (port === null) throw new Error(`open_project(${slug}) returned no port`);
  state.port = port;
  publishState();

  previewFrame.src = `http://127.0.0.1:${port}/`;
  previewFrame.hidden = false;
  placeholderEl.hidden = true;
}

async function closeCurrent(): Promise<void> {
  if (!state.currentSlug) return;
  const slug = state.currentSlug;
  try {
    await callTool('close_project', { slug });
  } finally {
    state.currentSlug = null;
    state.port = null;
    state.previewLoaded = false;
    setSelected(null);
    previewFrame.hidden = true;
    previewFrame.src = 'about:blank';
    placeholderEl.hidden = false;
    placeholderEl.textContent = 'Select a project to start its preview.';
    publishState();
  }
}

previewFrame.addEventListener('load', () => {
  // about:blank fires this too — only count loads that have a real src.
  if (previewFrame.src && previewFrame.src.startsWith('http://127.0.0.1:')) {
    state.previewLoaded = true;
    publishState();
  }
});

// Smoke surface — exposed before connect so a test can install a watcher
// before the bridge handshake completes.
window.__hyperframes_open = openSlug;
window.__hyperframes_close = closeCurrent;
publishState();

(async () => {
  try {
    await app.connect(transport);
    setStatus('connected');
    await loadProjects();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    setStatus('error', msg);
    console.error('[hyperframes-wrapper] connect/list failed', err);
  }
})();
