/* =================================================================
   Ikenga · shell.js — render the desktop shell as HTML strings.
   Use: window.Shell.layout({...}), Shell.sidebar({...}), etc.
   ================================================================= */
(function () {

  // ----- Common SVG icon set --------------------------------------
  var ICONS = {
    horn:        '<svg viewBox="0 0 32 32" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M16 8 L16 14"/><path d="M16 14 C 10 14, 6 18, 6 24"/><path d="M16 14 C 22 14, 26 18, 26 24"/><circle cx="16" cy="14" r="1.2" fill="currentColor"/><path d="M11 22 L13 20 M19 20 L21 22" opacity=".6"/></svg>',
    app:         '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="4" y="4" width="7" height="7" rx="1"/><rect x="13" y="4" width="7" height="7" rx="1"/><rect x="4" y="13" width="7" height="7" rx="1"/><rect x="13" y="13" width="7" height="7" rx="1"/></svg>',
    mail:        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 7l9 6 9-6"/></svg>',
    outbox:      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>',
    studio:      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><polygon points="6 4 20 12 6 20"/></svg>',
    agents:      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="12" cy="12" r="3"/><circle cx="12" cy="12" r="9" opacity=".5"/></svg>',
    files:       '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z"/></svg>',
    sessions:    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><polyline points="4 7 8 11 4 15"/><line x1="12" y1="15" x2="20" y2="15"/></svg>',
    canvas:      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="13.5" cy="6.5" r="1"/><circle cx="17.5" cy="10.5" r="1"/><circle cx="8.5" cy="7.5" r="1"/><circle cx="6.5" cy="12.5" r="1"/><path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.926 0 1.648-.746 1.648-1.688 0-.437-.18-.835-.437-1.125-.29-.289-.438-.652-.438-1.125a1.64 1.64 0 0 1 1.668-1.668h1.996c3.051 0 5.555-2.503 5.555-5.554C21.965 6.012 17.461 2 12 2z"/></svg>',
    imageGen:    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>',
    settings:    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09a1.65 1.65 0 0 0 1.51-1z" opacity=".5"/></svg>',
    terminal:    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><polyline points="4 7 8 11 4 15"/><line x1="12" y1="15" x2="20" y2="15"/></svg>',
    chat:        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg>',
    artifact:    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="12" cy="12" r="3"/><path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7-10-7-10-7z"/></svg>',
    pin:         '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M12 2 L12 8 L8 11 L8 14 L11 14 L11 21 L13 21 L13 14 L16 14 L16 11 L12 8 Z" fill="currentColor" stroke="none"/></svg>',
    close:       '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><polyline points="18 6 6 18"/><polyline points="6 6 18 18"/></svg>',
    chevronR:    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><polyline points="9 6 15 12 9 18"/></svg>',
    chevronL:    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><polyline points="15 6 9 12 15 18"/></svg>',
    expand:      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><polyline points="13 17 19 11 13 5"/><polyline points="5 17 11 11 5 5"/></svg>',
    collapse:    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><polyline points="11 17 5 11 11 5"/><polyline points="19 17 13 11 19 5"/></svg>',
    plus:        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M12 5v14M5 12h14"/></svg>',
    split:       '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="3" y="3" width="18" height="18" rx="1"/><line x1="12" y1="3" x2="12" y2="21"/></svg>',
    splitV:      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="3" y="3" width="18" height="18" rx="1"/><line x1="3" y1="12" x2="21" y2="12"/></svg>',
    refresh:     '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><polyline points="21 3 21 8 16 8"/></svg>',
    closeBig:    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="6" y1="6" x2="18" y2="18"/><line x1="6" y1="18" x2="18" y2="6"/></svg>',
    user:        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="12" cy="8" r="4"/><path d="M5 21v-2a4 4 0 0 1 4-4h6a4 4 0 0 1 4 4v2"/></svg>',
    iyke:        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="4" fill="currentColor"/></svg>'
  };

  // ----- Activity bar (Option B: 7 modes + Settings + 2 mini-apps) -----
  var ACTIVITY_MODES = [
    { key: 'app',      label: 'App',      icon: ICONS.app,       short: '⌘1' },
    { key: 'mail',     label: 'Mail',     icon: ICONS.mail,      short: '⌘2' },
    { key: 'outbox',   label: 'Outbox',   icon: ICONS.outbox,    short: '⌘3' },
    { key: 'studio',   label: 'Studio',   icon: ICONS.studio,    short: '⌘4' },
    { key: 'agents',   label: 'Agents',   icon: ICONS.agents,    short: '⌘5' },
    { key: 'files',    label: 'Files',    icon: ICONS.files,     short: '⌘6' },
    { key: 'sessions', label: 'Sessions', icon: ICONS.sessions,  short: '⌘7' }
  ];
  var MINI_APPS = [
    { key: 'canvas-design',    label: 'Canvas Design',    icon: ICONS.canvas },
    { key: 'image-generator',  label: 'Image Generator',  icon: ICONS.imageGen }
  ];

  function activityBar(opts) {
    opts = opts || {};
    var active = opts.active || 'mail';
    var badged = opts.badged || ['mail']; // workspaces with unread/activity dot
    var html = '<div class="activity">';
    html += '<span class="horn-mark">' + ICONS.horn + '</span>';
    ACTIVITY_MODES.forEach(function (m) {
      var on = m.key === active ? ' is-on' : '';
      var badge = badged.indexOf(m.key) >= 0 ? '<span class="rail-icon-badge"></span>' : '';
      html += '<button class="rail-icon' + on + '" title="' + m.label + ' · ' + m.short + '" data-ws="' + m.key + '">' + m.icon + badge + '</button>';
    });
    // Separator
    html += '<div style="height: 8px;"></div>';
    html += '<div style="height: 1px; width: 24px; background: var(--border-soft); margin: 4px 0;"></div>';
    MINI_APPS.forEach(function (m) {
      var on = m.key === active ? ' is-on' : '';
      html += '<button class="rail-icon' + on + '" title="' + m.label + '" data-ws="' + m.key + '">' + m.icon + '</button>';
    });
    html += '<span class="activity-spacer"></span>';
    var settingsOn = active === 'settings' ? ' is-on' : '';
    html += '<button class="rail-icon' + settingsOn + '" title="Settings · ⌘," data-ws="settings">' + ICONS.settings + '</button>';
    html += '</div>';
    return html;
  }

  // ----- Sidebar (head + groups + shared foot) ---------------------
  function sidebar(opts) {
    opts = opts || {};
    var head = opts.head || { mark: ICONS.app, name: 'App', mode: '' };
    var groups = opts.groups || [];
    var foot = opts.foot || { name: 'Chinedum', host: 'A · dark' };

    var html = '<div class="sidebar">';

    // Head with workspace-tinted gradient
    html += '<div class="sidebar-head">';
    html += '<span class="sidebar-head-mark">' + head.mark + '</span>';
    html += '<span class="sidebar-head-name">' + head.name + '</span>';
    if (head.mode) html += '<span class="sidebar-head-mode">' + head.mode + '</span>';
    html += '</div>';

    // Body — groups of nav items
    html += '<div class="sidebar-body">';
    groups.forEach(function (g) {
      html += '<div class="nav-group">';
      if (g.label) html += '<div class="nav-group-label">' + g.label + '</div>';
      g.items.forEach(function (item) {
        var cls = 'nav-item';
        if (item.active) cls += ' is-on';
        if (item.hot) cls += ' is-hot';
        html += '<div class="' + cls + '">';
        html += item.icon || '';
        html += item.label;
        if (item.count != null) html += '<span class="nav-item-count">' + item.count + '</span>';
        html += '</div>';
      });
      html += '</div>';
    });
    html += '</div>';

    // Foot
    html += '<div class="sidebar-foot">';
    html += '<div style="width:24px;height:24px;border-radius:50%;background:linear-gradient(135deg,var(--primary-soft),var(--primary));display:grid;place-items:center;font-family:var(--font-display);font-weight:500;font-size:11px;color:var(--fg);">N</div>';
    html += '<span class="sidebar-foot-name">' + foot.name + '</span>';
    html += '<span class="sidebar-foot-host">' + foot.host + '</span>';
    html += '</div>';

    html += '</div>';
    return html;
  }

  // ----- Content tab strip ----------------------------------------
  function contentTabs(opts) {
    opts = opts || {};
    var tabs = opts.tabs || [];
    var actions = opts.actions !== false;
    var html = '<div class="content-tabs">';
    tabs.forEach(function (t, i) {
      var cls = 'content-tab';
      if (t.active) cls += ' is-on';
      if (t.pinned) cls += ' is-pinned';
      var icon = t.icon ? '<span style="display:grid;place-items:center;">' + t.icon + '</span>' : '';
      var pin = t.pinned ? '<span class="pin">' + ICONS.pin + '</span>' : '';
      var closeBtn = t.pinned ? '' : '<span class="close">' + ICONS.close + '</span>';
      html += '<button class="' + cls + '" data-tab="' + i + '">' + icon + '<span>' + t.label + '</span>' + pin + closeBtn + '</button>';
    });
    if (actions) {
      // Action cluster — mirrors src/shell/panes/pane-toolbar.tsx.
      // Order: "+" New tab · | · refresh · split-right · split-down · close.
      // The hairline divider separates "create" intent (the "+") from
      // structural/destructive intent (split, close).
      var canSplit = opts.canSplit !== false;
      var canClose = opts.canClose !== false;
      var splitTitle = canSplit ? '' : ' disabled aria-disabled="true"';
      var closeTitle = canClose ? '' : ' disabled aria-disabled="true"';
      var splitTip = canSplit ? 'Split right (⌘\\)' : 'Max 6 panes';
      var splitVTip = canSplit ? 'Split down (⌘⇧\\)' : 'Max 6 panes';
      var closeTip = canClose ? 'Close pane' : 'Cannot close last pane';
      html += '<span class="content-tabs-actions">';
      html += '<button class="btn-icon" title="New tab">' + ICONS.plus + '</button>';
      html += '<span class="pane-actions-divider" aria-hidden="true"></span>';
      html += '<button class="btn-icon" title="Refresh pane">' + ICONS.refresh + '</button>';
      html += '<button class="btn-icon" title="' + splitTip + '"' + splitTitle + '>' + ICONS.split + '</button>';
      html += '<button class="btn-icon" title="' + splitVTip + '"' + splitTitle + '>' + ICONS.splitV + '</button>';
      html += '<button class="btn-icon" data-danger title="' + closeTip + '"' + closeTitle + '>' + ICONS.closeBig + '</button>';
      html += '</span>';
    }
    html += '</div>';
    return html;
  }

  // ----- Dock pane (collapsed rail OR expanded with tabs) ----------
  function dockTab(t) {
    var cls = 'dock-tab';
    if (t.active) cls += ' is-on';
    if (t.pinned) cls += ' is-pinned';
    var icon = t.icon ? '<span style="display:grid;place-items:center;">' + t.icon + '</span>' : '';
    var pin = t.pinned ? '<span class="pin">' + ICONS.pin + '</span>' : '';
    var closeBtn = t.pinned ? '' : '<span class="close">' + ICONS.close + '</span>';
    return '<button class="' + cls + '" data-tab="' + (t.key || '') + '">' + icon + '<span>' + t.label + '</span>' + pin + closeBtn + '</button>';
  }

  function dockCollapsedRail(opts) {
    opts = opts || {};
    var tabs = opts.tabs || [];
    var html = '<div class="dock-collapsed-rail">';
    html += '<button class="rail-icon" title="Expand dock · ⌘.">' + ICONS.collapse + '</button>';
    html += '<div style="height: 4px;"></div>';
    tabs.forEach(function (t) {
      var on = t.active ? ' is-on rail-right' : '';
      html += '<button class="rail-icon' + on + '" title="' + t.label + '">' + (t.icon || ICONS.app) + '</button>';
    });
    html += '<span class="activity-spacer"></span>';
    html += '<button class="rail-icon" title="Add tab">' + ICONS.plus + '</button>';
    html += '</div>';
    return html;
  }

  function dock(opts) {
    opts = opts || {};
    var state = opts.state || 'collapsed'; // collapsed | expanded | wide | hidden
    if (state === 'hidden') return '<div class="dock" data-state="hidden"></div>';
    if (state === 'collapsed') {
      return '<div class="dock" data-state="collapsed">' + dockCollapsedRail({ tabs: opts.tabs || [] }) + '</div>';
    }
    var html = '<div class="dock" data-state="' + state + '">';
    // Head — scrollable tab strip + pinned actions (new + collapse).
    html += '<div class="dock-head">';
    html += '<div class="dock-head-tabs">';
    (opts.tabs || []).forEach(function (t) { html += dockTab(t); });
    html += '</div>';
    html += '<div class="dock-head-actions">';
    html += '<button class="btn-icon" title="New tab">' + ICONS.plus + '</button>';
    html += '<button class="dock-collapse" title="Collapse dock · ⌘.">' + ICONS.expand + '</button>';
    html += '</div>';
    html += '</div>';
    // Body
    html += '<div class="dock-body">' + (opts.body || '') + '</div>';
    // Foot
    if (opts.foot) {
      html += '<div class="dock-foot">' + opts.foot + '</div>';
    }
    html += '</div>';
    return html;
  }

  // ----- Title bar -------------------------------------------------
  function titlebar(opts) {
    opts = opts || {};
    var title = opts.title || 'ikenga';
    return '<div class="shell-titlebar">' +
      '<span class="shell-titlebar-dot"></span>' +
      '<span class="shell-titlebar-dot"></span>' +
      '<span class="shell-titlebar-dot"></span>' +
      '<span class="shell-titlebar-meta">' + title + '</span>' +
      '</div>';
  }

  // ----- Full layout composer --------------------------------------
  function layout(opts) {
    opts = opts || {};
    var sidebarState = opts.sidebarState || 'expanded';
    var dockState = opts.dockState || 'collapsed';
    var html = '<div class="shell-frame">';
    html += titlebar({ title: opts.title });
    html += '<div class="shell" data-sidebar="' + sidebarState + '" data-dock="' + dockState + '" style="--shell-h:' + (opts.height || 760) + 'px;">';
    html += opts.activityBar || '';
    html += opts.sidebar || '';
    html += opts.content || '';
    html += opts.dock || '';
    html += '</div>';
    html += '</div>';
    return html;
  }

  // ----- Public API -----------------------------------------------
  window.Shell = {
    ICONS: ICONS,
    ACTIVITY_MODES: ACTIVITY_MODES,
    MINI_APPS: MINI_APPS,
    activityBar: activityBar,
    sidebar: sidebar,
    contentTabs: contentTabs,
    dock: dock,
    dockTab: dockTab,
    titlebar: titlebar,
    layout: layout
  };
})();
