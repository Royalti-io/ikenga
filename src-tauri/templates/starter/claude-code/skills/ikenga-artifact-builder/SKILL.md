---
name: ikenga-artifact-builder
description: |
  Author a self-contained interactive HTML artifact (dashboard, view,
  comparison, mockup) that renders standalone in any browser AND lights up
  with live data when opened inside the Ikenga shell. Replaces .md for
  visual/interactive/data-bearing outputs.

  TRIGGER when: the user asks for a dashboard, view, summary-as-page,
  comparison, mockup, prototype, "make me an HTML…", or any output where
  interactivity or live data adds value over static text. Also trigger when
  CLAUDE.md / memory has a rule preferring artifacts over .md for visual
  outputs.

  DO NOT TRIGGER for: prose, technical writeups, decision docs, READMEs,
  long-form explanations, code reviews — those stay as .md.
license: BUSL-1.1
---

# Ikenga Artifact Builder

You produce **single-file HTML artifacts** that:

- Render standalone in any browser (claude.ai's artifact viewer included).
- Light up with live data when opened inside the Ikenga shell.
- Are easy to share, review, paste into chat, and iterate on.

## When to produce an artifact vs a .md file

| Situation | Output |
|-----------|--------|
| Dashboard, KPIs, charts | Artifact |
| Comparison table the user will scan/sort | Artifact |
| UI mockup, prototype, design exploration | Artifact |
| Anything with live data (SQL, Supabase, API, MCP) | Artifact |
| Status page the user wants to refresh | Artifact |
| Prose, writeups, decision docs, READMEs | `.md` |
| Step-by-step instructions, runbooks | `.md` |
| Code reviews, technical analysis | `.md` |

If unsure, ask: *"will the user **interact** with this, or just **read** it?"* Interact → artifact. Read → markdown.

## The hard rules

1. **Single self-contained HTML file** unless the user explicitly asks for a folder/multi-page artifact.
2. **Must render with no network access** — include a `<script id="ikenga-mock-data" type="application/json">` block with realistic mock data, and the page must use it as a fallback when the bridge is absent or sources fail.
3. **No `eval`, no `Function(...)`, no `document.write`** — claude.ai's artifact viewer blocks them, and our shell's CSP does too.
4. **No external network in the static layer** unless declared in `dataSources`. CDN imports (React, Tailwind, the bridge) are fine; ad-hoc `fetch` calls are not.
5. **Manifest is mandatory** as `<script type="application/json" id="ikenga-manifest">…</script>`. The `fallback` block in it is mandatory for any artifact you intend to share.

If you can't satisfy these, write a `.md` instead and tell the user why.

## File layout

### Single-file (default)

```
output.html    ← the whole artifact, including manifest, mock data, styles, code
```

### Folder (only when user asks for assets, sub-pages, or large data)

```
my-artifact/
├── index.html
├── manifest.json
├── data/
│   └── mock.json
└── assets/
    └── logo.svg
```

## Single-file template

Start from this skeleton. Fill in the marked regions; do not restructure.

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>{{ARTIFACT NAME}}</title>

  <!-- Manifest. Required. Auto-derived capabilities; no explicit block needed. -->
  <script type="application/json" id="ikenga-manifest">
  {
    "format": "ikenga-artifact",
    "formatVersion": "0.1",
    "id": "{{kebab-case-id}}",
    "name": "{{Human Name}}",
    "version": "0.1.0",
    "description": "{{One-line purpose.}}",
    "license": "BUSL-1.1",
    "icon": { "lucide": "{{lucide-icon-name}}" },
    "dataSources": {
      /* declare every live source here; bridge auto-fetches on init */
    },
    "fallback": {
      "mode": "mock",
      "dataTag": "ikenga-mock-data",
      "banner": "Running outside Ikenga — showing mock data."
    },
    "pin": {
      "suggested": false,
      "section": "{{suggested-section-or-omit}}",
      "label": "{{Short label}}"
    },
    "requires": { "ikenga": ">=0.4", "bridge": "^1.0" }
  }
  </script>

  <!-- Mock data. Required. Must match shape of live sources. -->
  <script type="application/json" id="ikenga-mock-data">
  {
    /* one key per dataSource; values match what live source would return */
  }
  </script>

  <!-- Styles. Tailwind via CDN OK. Inline custom styles below. -->
  <script src="https://cdn.tailwindcss.com"></script>
  <style>
    /* custom styles only — keep minimal */
  </style>

  <!-- React UMD (globals: React, ReactDOM). Pin minor — unpinned URLs occasionally serve breaking minors. -->
  <script crossorigin src="https://cdn.jsdelivr.net/npm/react@18.3.1/umd/react.production.min.js"></script>
  <script crossorigin src="https://cdn.jsdelivr.net/npm/react-dom@18.3.1/umd/react-dom.production.min.js"></script>

  <!-- Babel-standalone for in-browser JSX. Loaded from cache inside Ikenga (shell pre-injects). -->
  <script src="https://cdn.jsdelivr.net/npm/@babel/standalone@7.25.6/babel.min.js"></script>
</head>

<body class="bg-neutral-50 text-neutral-900 dark:bg-neutral-950 dark:text-neutral-100 antialiased">
  <!-- Visible placeholder so a JS-init failure is distinguishable from a CSS/HTML failure. -->
  <div id="root">
    <div class="max-w-2xl mx-auto p-6 text-sm text-neutral-500">Initializing…</div>
  </div>

  <!--
    Plain `text/babel` (NOT `data-type="module"`) + UMD React globals + IIFE async.
    Why: `text/babel` + ESM imports + top-level `await` is brittle in Babel-standalone
    and produces silent blank pages. The pattern below is the one validated by the
    three v0 example artifacts; do not switch to ESM imports unless you've also
    confirmed Babel-standalone has matured around module mode.
  -->
  <script type="text/babel" data-presets="env,react">
    (function () {
      const { useState, useEffect } = React;

      // Recommended hook: subscribes once, re-renders on refresh. Use one per source.
      function useSource(art, name) {
        const [value, setValue] = useState(() => art.source(name).get());
        useEffect(() => art.source(name).subscribe(setValue), [art, name]);
        return [value, () => art.source(name).refresh()];
      }

      function App({ art }) {
        // const [foo, refreshFoo] = useSource(art, 'foo');

        return (
          <div className="max-w-2xl mx-auto p-6">
            {art.host.anyFallback() && (
              <div className="mb-4 px-3 py-2 rounded border border-amber-200 dark:border-amber-900/50 bg-amber-50 dark:bg-amber-900/20 text-amber-900 dark:text-amber-200 text-sm">
                Showing mock data for one or more sources.
              </div>
            )}
            {/* render here */}
          </div>
        );
      }

      // Once `@ikenga/artifact` is on a CDN, replace the polyfill reference with:
      //   const art = await bridge.init();
      // (still inside this IIFE — do not hoist top-level await out of it).
      window.__ikenga_bridge_polyfill__.init().then(function (art) {
        ReactDOM.createRoot(document.getElementById('root')).render(<App art={art} />);
      }).catch(function (err) {
        // Visible error surface — far easier to debug than a silent blank page.
        document.getElementById('root').innerHTML =
          '<pre style="padding:2rem;color:#b91c1c;font-family:ui-monospace,monospace;white-space:pre-wrap">'
          + 'Init failed: ' + (err && err.message ? err.message : String(err))
          + '</pre>';
        console.error('[ikenga] init failed', err);
      });
    })();
  </script>
</body>
</html>
```

**Note on JSX + Babel.** `data-presets="env,react"` enables JSX. The artifact opens directly in any browser (`file://`, claude.ai, Ikenga shell) without a build step. Inside Ikenga, the shell pre-injects `@babel/standalone` into the artifact iframe, so the artifact's `<script src>` resolves from cache (~300KB paid once per shell session, not per artifact).

**Why UMD + IIFE, not ESM + top-level await.** `<script type="text/babel" data-type="module">` with ESM imports and top-level `await` produces silent blank pages with current Babel-standalone — validated empirically while building the v0 examples. The UMD-globals + plain-`text/babel` + IIFE-async pattern above survives in every host we tested (`file://`, claude.ai's artifact viewer, the Launch preview panel). Revisit when Babel-standalone's module mode hardens.

**Why pinned CDN versions.** Unpinned URLs (`react@18`, `@babel/standalone@7`) occasionally serve a breaking minor that bricks all artifacts referencing them. Always pin to a tested patch (`react@18.3.1`, `@babel/standalone@7.25.6`).

## Data source types

Every entry in `dataSources` has a `type`, type-specific config, and a `refresh` block.

### `supabase`

```json
{
  "type": "supabase",
  "table": "v_cash_position",
  "select": "id, amount, currency, as_of",
  "filter": [["currency", "eq", "USD"]],
  "refresh": { "mode": "interval", "every": "15m", "onFocus": true }
}
```

Outside Ikenga: returns mock data from the `dataTag` block. Inside Ikenga: bridge resolves Supabase project from manifest's host context, RLS applies as the current user.

### `sql` (local SQLite)

```json
{
  "type": "sql",
  "db": "ikenga.local",
  "query": "select * from ar_aging_view",
  "params": [],
  "refresh": { "mode": "manual" }
}
```

Read-only. Bind parameters via `params`. Outside Ikenga: mock.

### `fetch` (HTTP)

```json
{
  "type": "fetch",
  "url": "https://api.example.com/fx/today",
  "method": "GET",
  "headers": {},
  "refresh": { "mode": "interval", "every": "1h" }
}
```

Network host added to the artifact's CSP allowlist automatically. Outside Ikenga: bridge attempts the fetch directly (subject to browser CORS); falls back to mock on failure.

### `mcp`

```json
{
  "type": "mcp",
  "server": "royalti-cms",
  "tool": "findPosts",
  "args": { "limit": 10 },
  "refresh": { "mode": "manual" }
}
```

Inside Ikenga only — bridge routes through the shell's MCP registry. Outside: mock.

### `file` (local watched file)

```json
{
  "type": "file",
  "path": "./data/last_run.json",
  "refresh": { "mode": "watch" }
}
```

Folder-mode only. Bridge watches via shell's fs_watch. Outside: reads once if reachable, else mock.

## `refresh` modes

- `{ "mode": "manual" }` — only when `art.source(name).refresh()` is called.
- `{ "mode": "interval", "every": "15m" }` — `1s`, `30s`, `5m`, `1h`, `1d` etc.
- `{ "mode": "interval", "every": "15m", "onFocus": true }` — also refresh when pane regains focus.
- `{ "mode": "watch" }` — file/realtime sources only.

## Compatibility constraints

- **No `eval`, `Function`, `document.write`.**
- **No inline event handlers** (`onclick="…"`, `onload="…"`). React `onClick={fn}` JSX is fine — it's a property, not an HTML attribute. Inline `style="…"` is also fine.
- **CSP-friendly.** Prefer Tailwind classes or `<style>` blocks over inline `style=` attributes when practical.
- **CDN imports only from**: `esm.sh`, `cdn.skypack.dev`, `cdn.tailwindcss.com`, `cdn.jsdelivr.net`. Anything else needs to be declared in `dataSources` (and thus in the network allowlist). Drop `unpkg.com` — `esm.sh`/`jsdelivr` are strictly better.
- **Pin CDN versions.** Use `react@18.3.1`, `@babel/standalone@7.25.6`, etc. Unpinned URLs occasionally serve breaking minors and silently brick artifacts.
- **Entry HTML ≤ 500KB** (warn) / 2MB (error). Folder-mode `assets/` and `data/` are uncapped.
- **No service workers, no `localStorage` for sensitive data.** Use `art.state.set/get` (host-mediated, SQLite-backed inside Ikenga, `localStorage` fallback in plain browser).
- **Visible "Initializing…" placeholder + visible init-error panel.** A blank page during dev means you can't tell whether HTML failed, CSS failed, or JS failed. Use the patterns in the template; don't omit them.

## Notes-back loop (auto-wired)

The bridge auto-injects a floating **"💬 comment" button in the bottom-right** of every artifact. Click → comment mode (cursor crosshair, click any element to attach a note → text input → send). Modal toggle, off by default — your own click handlers are untouched when comment mode is off.

In `ikenga` and `preview-cli` hosts, notes route back to the originating chat session with a marker linking to the artifact + selector. In plain `browser` host, the button is hidden (no chat to route to).

To opt out (printable reports, embedded widgets, anywhere the chrome would be wrong):

```json
"notes": { "enabled": false }
```

Explicit API still available when an artifact has its own feedback UI:

```js
art.notes.send("This chart needs a 90-day toggle", { selector: "#cash-chart" });
```

## Style guidance

- **Default to system fonts** + Tailwind — looks clean, ships nothing extra.
- **Respect `prefers-color-scheme`**: light + dark variants via Tailwind's `dark:` modifier.
- **Density**: dashboards skew dense (people scan). Mockups skew spacious. Pick one and commit.
- **Don't reinvent chart libraries** — for any non-trivial chart, import `recharts` or `apache-echarts` via esm.sh. For sparklines or single-metric tiles, hand-rolled SVG is fine and lighter.
- **Keep total visual elements ≤ 7 per screen.** If you have more, split into tabs or sub-pages (folder mode).
- **Design tokens are optional.** Default template uses raw Tailwind. Artifacts that should match shell visual identity can import `@ikenga/tokens` via the `--with-tokens` preview flag. Don't import unless asked.

## Workflow

1. **Clarify scope.** If the user's ask is ambiguous (e.g., "make me a dashboard"), ask one clarifying question: what data, what timeframe, what's the primary decision they're making with it. Don't ask more than one — unblock and iterate.
2. **Sketch data sources.** List every piece of data the artifact needs. For each, decide source type and refresh mode. Write the `dataSources` block first, then `mock-data` to match.
3. **Build the React tree.** Use the `useSource(art, name)` hook (in the template) — it returns `[value, refresh]` and handles subscribe/unsubscribe. One call per source. Avoid hand-rolling `useEffect` subscriptions unless you have a reason to.
4. **Write the fallback path.** Confirm the artifact renders correctly with mock data alone (close the live data subscriptions, reload — does it still work?).
5. **Self-check the compatibility rules.** No eval, no inline handlers, file size, CSP. Run the checklist before delivering.
6. **Deliver.** Tell the user where the file is, how to open it (just open in a browser, or open in Ikenga for live data), and what to do next (review, leave notes, ask for changes).

## Self-check before delivering

- [ ] Manifest tag present and valid JSON
- [ ] Mock data tag present, shape matches every dataSource
- [ ] Renders with no network (mock-only)
- [ ] No `eval`, `Function`, `document.write`, inline event handlers
- [ ] All CDN imports from approved hosts
- [ ] Single file under 500KB (or in folder mode)
- [ ] Light + dark mode both legible
- [ ] `pin.section` is a sensible suggestion or omitted

If any box is unchecked, fix before delivering.

## Bridge surface (cheat sheet)

Inside the IIFE, after `init()`:

```js
// Sources
art.source(name).get();                  // current cached value (sync)
art.source(name).subscribe(fn);          // returns unsubscribe; fires on refresh
art.source(name).refresh();              // manual refetch; returns Promise

// Host introspection
art.host.kind;                           // 'ikenga' | 'browser' | 'preview-cli'
art.host.user;                           // identity, null in plain browser
art.host.usedFallback(name);             // true if this source fell back to mock
art.host.anyFallback();                  // true if any source did

// Persisted UI state — sort, filter, tab, date range
art.state.get(key);
art.state.set(key, value);
art.state.subscribe(key, fn);

// Notes-back loop (host-mode only; no-op + clipboard fallback elsewhere)
art.notes.send(text, { selector });

// Pin request — UI handshake to add to activity bar
art.pin();
```

## Worked examples

Three references, in order of complexity. Open the source of each before writing your own.

- **`references/hello-world.html`** — minimal, single fetch source, ~150 lines. Smallest valid artifact. Read first.
- **`references/cfo-daily.html`** — financial dashboard, four data sources (supabase + sql + fetch + file), three refresh modes (interval / manual / watch), ~330 lines. Tests numerical/tabular data, KPI tiles, AR aging table with overdue highlighting, FX rates, cash-by-account bar chart.
- **`references/ceo-overview.html`** — exec digest, six sources spanning all four types (kpis supabase, agent_runs + calendar mcp, notifications sql, recent_docs file, team_signals fetch), ~470 lines. Tests narrative + structured signals + **cross-artifact links** (the cfo-bot agent run links to `cfo-daily.html`). The shape of most real-world artifacts beyond charts.

Use these as the canonical reference for **shape**, not styling. Copy structure, not visual choices. The polyfill block in each is identical — when `@ikenga/artifact` ships, all three will swap their inline polyfill for one CDN import without touching the App code.
