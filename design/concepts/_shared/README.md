# Ikenga · Shared design assets

Reusable CSS + JS used by every screen file in `design/concepts/`. Locked specs live in `design/system/`.

## Files

| File | What it is |
|---|---|
| `tokens.css` | Theme × mode × density token system. Mirrors `design/system/tokens.md`. |
| `components.css` | Primitive styles (`.btn`, `.input`, `.badge`, `.tab`, `.rail-icon`, etc.). Mirrors `design/system/primitives.md`. |
| `shell.css` | Desktop shell layout — `.shell-frame`, `.activity`, `.sidebar`, `.content`, `.dock`. |
| `controls.js` | Sticky controls bar — renders Theme/Mode/Density (+ optional Workspace, Dock) and the Screens dropdown. Sets `<html>` data-attrs, persists to `localStorage`. Auto-mounts every `[data-controls-bar]` slot on script load. |
| `shell.js` | `window.Shell` — JS template helpers that return HTML strings for the shell chrome. |

## How to use in a screen file

```html
<!DOCTYPE html>
<html data-theme="A" data-mode="dark" data-density="comfortable" data-workspace="mail">
<head>
  <link rel="stylesheet" href="../_shared/tokens.css">
  <link rel="stylesheet" href="../_shared/components.css">
  <link rel="stylesheet" href="../_shared/shell.css">
  <!-- Google fonts… -->
</head>
<body>
  <!-- Sticky controls bar — controls.js fills this on script load -->
  <div class="controls"
       data-controls-bar
       data-current="inbox"
       data-show-dock="1"
       data-show-workspace="1"></div>

  <div class="page">
    <header>...</header>
    <div id="shell-slot"></div>
  </div>

  <script src="../_shared/shell.js"></script>
  <script src="../_shared/controls.js"></script>
  <script>
    document.getElementById('shell-slot').innerHTML = Shell.layout({
      title: 'ikenga · /mail/inbox',
      sidebarState: 'expanded',           // expanded | collapsed | hidden
      dockState: 'expanded',               // collapsed | expanded | wide | hidden
      height: 760,
      activityBar: Shell.activityBar({ active: 'mail', badged: ['mail'] }),
      sidebar: Shell.sidebar({
        head: { mark: Shell.ICONS.mail, name: 'Mail', mode: '12 unread' },
        groups: [
          { items: [ { label: 'Inbox', icon: Shell.ICONS.mail, count: 12, active: true, hot: true } ] }
        ]
      }),
      content: '<div class="content">' +
        Shell.contentTabs({ tabs: [ { label: 'Inbox', active: true } ] }) +
        '<div class="content-body">…actual screen content…</div>' +
      '</div>',
      dock: Shell.dock({
        state: 'expanded',
        tabs: [
          { key: 'chat',     label: 'Chat',     icon: Shell.ICONS.chat,     active: true, pinned: true },
          { key: 'terminal', label: 'Terminal', icon: Shell.ICONS.terminal }
        ],
        body: '<div style="padding: 16px;">…dock content…</div>',
        foot: 'Claude Opus 4.7 · 1M context'
      })
    });
  </script>
</body>
</html>
```

## Activity bar modes (Option B)

7 first-class workspaces + Settings + 2 mini-apps:

```
App ⌘1 · Mail ⌘2 · Outbox ⌘3 · Studio ⌘4 · Agents ⌘5 · Files ⌘6 · Sessions ⌘7
                  ───
                  Canvas Design · Image Generator
                  ───
                  Settings ⌘,
```

Mail and Outbox are first-class — they swap the sidebar entirely. The current code uses 5 + 3; this design promotes Mail/Outbox/Studio to rails (code update tracked separately).

## Dock pane

Right-edge pane. **Global** — its tabs persist across workspace switches. **Collapsible** — 36px collapsed rail or 380/480px expanded. **Tabs are bidirectional** — drag content tabs into the dock, drag dock tabs out into content panes.

States via `data-dock` on `.shell`:
- `collapsed` — 36px rail showing tab icons + add/expand
- `expanded` — 380px with full tab strip + body
- `wide` — 480px (for chat with code blocks etc.)
- `hidden` — 0px (focus mode)

## Controls bar (`controls.js`)

All screens share one sticky bar. Don't hand-write the inner segments. Two ways to mount:

### Auto-mount (preferred — most screens)

Drop a slot div near the top of `<body>`:

```html
<div class="controls"
     data-controls-bar
     data-current="inbox"
     data-show-dock="1"
     data-show-workspace="1"></div>
```

Then later: `<script src="../_shared/controls.js"></script>`. The script auto-mounts every `[data-controls-bar]` slot synchronously on load — page scripts that follow can immediately query `#seg-dock`, `#seg-theme`, etc.

| Attribute | Purpose |
|---|---|
| `data-current` | Which screen is active. Highlights the matching item in the Screens dropdown. Use one of `shell`, `inbox`, `pane-anatomy`, `pane-route`. |
| `data-show-dock="1"` | Include the Dock segment (Rail / Open / Wide / Off). Wired by the page, not by the shared bar. |
| `data-show-workspace="1"` | Include the Workspace segment (App / Mail / Outbox / Studio / Agents / Files / Sessions / Settings). |

The Screens entry is a dropdown (button + popover menu), not a row of buttons. Add new screens by editing the `SCREENS` array in `controls.js`.

### Explicit mount (when you need extras)

Use this when the screen demos a control unique to itself (e.g., `00-shell.html` has a Sidebar segment):

```html
<div class="controls" id="controls-slot"></div>

<script src="../_shared/controls.js"></script>
<script>
  Controls.mount(document.getElementById('controls-slot'), {
    current: 'shell',
    dock: true,
    extras: '<div class="control-group">…sidebar seg HTML…</div>'
  });
</script>
```

`extras` HTML is injected between the universal left-side groups and the right-aligned (Dock / Screens) cluster. Skip the `data-controls-bar` attribute so auto-mount doesn't double-render.

## Editing the system

- **Token values** → edit `tokens.css` AND `design/system/tokens.md` (keep in sync)
- **New primitive** → add to `components.css`, document in `design/system/primitives.md`
- **New shell helper** → add to `shell.js`, update this README's API summary
- **New screen** → add a `{ id, label, href }` entry to `SCREENS` in `controls.js`

When changing primitive styles globally, refresh every `0X-screen.html` file once to verify nothing regressed (especially density variants).
