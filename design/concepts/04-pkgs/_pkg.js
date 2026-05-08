/* =================================================================
   Shared JS for 04-pkgs/1x-pkg-*.html files.
   Provides PkgComp helpers used by per-pkg HTMLs.
   ================================================================= */
(function () {
  var I = window.Shell.ICONS;

  // ---- Activity bar (decorative, current pkg active) -------------
  function activityBar(activeKey) {
    var lucide = {
      mail:    I.mail,
      work:    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 11 12 14 22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>',
      finance: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>',
      gtm:     '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>',
      product: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/></svg>',
      exec:    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3 9 12 2l9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>'
    };
    var keys = ['email', 'work', 'finance', 'gtm', 'product', 'exec'];
    var iconKey = { email:'mail', work:'work', finance:'finance', gtm:'gtm', product:'product', exec:'exec' };
    var html = '<div class="activity"><span class="horn-mark">' + I.horn + '</span>';
    keys.forEach(function (k) {
      var on = k === activeKey ? ' is-on' : '';
      html += '<button class="rail-icon' + on + '" title="' + k + '">' + lucide[iconKey[k]] + '</button>';
    });
    html += '<div style="height:6px"></div><div style="height:1px;width:24px;background:var(--border-soft);margin:4px 0;"></div>';
    html += '<button class="rail-icon" title="Iyke"></button>';
    html += '<button class="rail-icon" title="Storyboard"></button>';
    html += '<button class="rail-icon" title="Studio"></button>';
    html += '<button class="rail-icon" title="Hyperframes"></button>';
    html += '<span class="activity-spacer"></span>';
    html += '<button class="rail-icon" title="Settings">' + I.settings + '</button></div>';
    return html;
  }

  // ---- Sidebar ---------------------------------------------------
  function sidebar(opts) {
    var html = '<div class="sidebar">';
    html += '<div class="sidebar-head">' + (opts.icon || '') + '<span class="sidebar-head-name">' + opts.name + '</span><span class="sidebar-head-mode">' + (opts.mode || '') + '</span></div>';
    html += '<div class="sidebar-body">';
    (opts.groups || []).forEach(function (g) {
      if (g.label) html += '<div class="nav-section-label">' + g.label + '</div>';
      g.items.forEach(function (it) {
        var on = it.active ? ' is-on' : '';
        var ct = (it.count != null) ? '<span class="nav-item-count">' + it.count + '</span>' : '';
        html += '<div class="nav-item' + on + '">' + (it.icon || '') + '<span>' + it.label + '</span>' + ct + '</div>';
      });
    });
    html += '</div>';
    html += '<div class="sidebar-foot"><span>' + (opts.footLabel || '') + '</span><span style="margin-left:auto;color:' + (opts.footColor || 'var(--live)') + ';">' + (opts.footStatus || 'healthy') + '</span></div>';
    html += '</div>';
    return html;
  }

  // ---- Section tabs ---------------------------------------------
  function tabs(items, activeKey) {
    var html = '<div class="section-tabs">';
    items.forEach(function (t) {
      var on = t.k === activeKey ? ' is-on' : '';
      var ct = (t.count != null) ? '<span class="section-tab-count">' + t.count + '</span>' : '';
      html += '<button class="section-tab' + on + '">' + (t.icon || '') + '<span>' + t.label + '</span>' + ct + '</button>';
    });
    html += '</div>';
    return html;
  }

  // ---- Empty + loading states -----------------------------------
  function emptyState(opts) {
    return '<div class="pane-empty"><div style="display:grid;justify-items:center;text-align:center;">'
      + '<svg class="empty-art" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round">' + (opts.art || '') + '</svg>'
      + '<h2 class="empty-title">' + opts.title + '</h2>'
      + '<p class="empty-sub">' + opts.sub + '</p>'
      + '<div class="empty-actions">'
      +   '<button class="btn is-primary">' + (opts.primary || 'Get started') + '</button>'
      +   (opts.secondary ? '<button class="btn">' + opts.secondary + '</button>' : '')
      + '</div>'
      + '</div></div>';
  }

  function loadingRows(n, withTick) {
    var html = '';
    for (var i = 0; i < n; i++) {
      html += '<div class="list-row" style="cursor:default;">'
        + '<div class="list-row-tick" style="' + (withTick && i < 3 ? 'background:var(--tint-fg-active);opacity:.4;' : '') + '"></div>'
        + '<div class="list-row-main">'
        +   '<div class="skel-bar" style="width:35%;"></div>'
        +   '<div class="skel-bar" style="width:78%;"></div>'
        + '</div></div>';
    }
    return html;
  }

  // ---- Mount helper ---------------------------------------------
  function mount(stageId, activeKey, sidebarOpts, contentHtml) {
    var stage = document.getElementById(stageId);
    if (!stage) return;
    stage.innerHTML = activityBar(activeKey) + sidebar(sidebarOpts) + contentHtml;
  }

  window.PkgComp = {
    activityBar: activityBar,
    sidebar: sidebar,
    tabs: tabs,
    emptyState: emptyState,
    loadingRows: loadingRows,
    mount: mount,
    icons: I
  };
})();
