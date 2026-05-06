/* =================================================================
   Ikenga · controls.js — sticky control bar for all design screens.

   Two responsibilities:
   1. Build the control bar markup (Theme/Mode/Density + optional
      Workspace, Dock, Screens). Page-specific via data-attrs on the
      slot div.
   2. Wire each segment so clicks reflect into <html> data-attrs and
      persist to localStorage.

   Usage in a screen file (do NOT hand-write the inner markup):

     <div class="controls"
          data-controls-bar
          data-current="inbox"
          data-show-dock="1"
          data-show-workspace="1"></div>

     <!-- ... rest of body ... -->

     <script src="../_shared/controls.js"></script>

   The script auto-mounts every element with `[data-controls-bar]`
   synchronously when it loads — so page-specific scripts that follow
   can immediately query `#seg-dock`, `#seg-theme`, etc.
   ================================================================= */
(function () {
  var html = document.documentElement;

  /* --- Restore saved attrs on first load (must run before mount) -- */
  ['data-theme', 'data-mode', 'data-density', 'data-workspace'].forEach(function (attr) {
    var saved = localStorage.getItem('ikenga-' + attr);
    if (saved) html.setAttribute(attr, saved);
  });

  /* --- Screen registry — keep in sync with files in 03-screens/ --- */
  var SCREENS = [
    { id: 'shell',            label: 'Shell',           href: './00-shell.html' },
    { id: 'inbox',            label: 'Inbox',           href: './01-inbox.html' },
    { id: 'pane-anatomy',     label: 'Pane anatomy',    href: './02-pane-anatomy.html' },
    { id: 'pane-route',       label: 'Pane · route',    href: './03-pane-route.html' },
    { id: 'outbox-approvals', label: 'Outbox · approvals', href: './04-outbox-approvals.html' },
    { id: 'finance',          label: 'Finance · dashboard', href: './05-finance.html' },
    { id: 'sessions',         label: 'Sessions',           href: './06-sessions.html' },
    { id: 'claude-config',    label: '/claude · config',   href: './07-claude-config.html' },
    { id: 'tasks',            label: 'Tasks',              href: './08-tasks.html' }
  ];

  /* --- Markup builders -------------------------------------------- */
  function group(label, segId, buttons) {
    return ''
      + '<div class="control-group">'
      +   '<span class="control-label">' + label + '</span>'
      +   '<div class="seg"' + (segId ? ' id="' + segId + '"' : '') + '>' + buttons + '</div>'
      + '</div>';
  }

  function btn(val, label, dotColor) {
    var dot = dotColor ? '<span class="seg-dot" style="background:' + dotColor + ';"></span>' : '';
    return '<button data-val="' + val + '">' + dot + label + '</button>';
  }

  function themeSeg() {
    return group('Theme', 'seg-theme',
      btn('A', 'A', 'hsl(14,78%,52%)') +
      btn('B', 'B', 'hsl(42,82%,50%)') +
      btn('C', 'C', 'hsl(170,35%,50%)')
    );
  }

  function modeSeg() {
    return group('Mode', 'seg-mode',
      btn('dark', 'Dark') +
      btn('light', 'Light')
    );
  }

  function densitySeg() {
    return group('Density', 'seg-density',
      btn('compact', 'Compact') +
      btn('comfortable', 'Comfortable') +
      btn('spacious', 'Spacious')
    );
  }

  function workspaceSeg() {
    return group('Workspace', 'seg-workspace',
      btn('app', 'App') +
      btn('mail', 'Mail') +
      btn('outbox', 'Outbox') +
      btn('studio', 'Studio') +
      btn('agents', 'Agents') +
      btn('files', 'Files') +
      btn('sessions', 'Sessions') +
      btn('settings', 'Settings')
    );
  }

  function dockSeg() {
    return group('Dock', 'seg-dock',
      btn('collapsed', 'Rail') +
      btn('expanded', 'Open') +
      btn('wide', 'Wide') +
      btn('hidden', 'Off')
    );
  }

  function screensSeg(currentId) {
    var current = null;
    for (var i = 0; i < SCREENS.length; i++) {
      if (SCREENS[i].id === currentId) { current = SCREENS[i]; break; }
    }
    var label = current ? current.label : 'Screens';

    var items = SCREENS.map(function (s) {
      var cls = s.id === currentId ? ' class="is-on"' : '';
      return '<a href="' + s.href + '" role="menuitem"' + cls + '>'
        + '<span class="screens-menu-label">' + s.label + '</span>'
        + '<span class="screens-menu-href">' + s.href.replace('./', '') + '</span>'
        + '</a>';
    }).join('');

    var chevron = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><polyline points="6 9 12 15 18 9"/></svg>';

    return ''
      + '<div class="control-group" data-screens-dropdown>'
      +   '<span class="control-label">Screens</span>'
      +   '<div class="screens-dropdown">'
      +     '<button type="button" class="screens-trigger" aria-haspopup="menu" aria-expanded="false">'
      +       '<span class="screens-trigger-label">' + label + '</span>' + chevron
      +     '</button>'
      +     '<div class="screens-menu" role="menu" hidden>' + items + '</div>'
      +   '</div>'
      + '</div>';
  }

  /* --- Wire screens dropdown (toggle + outside-click + esc) ------- */
  function bindScreensDropdowns(scope) {
    var root = scope || document;
    root.querySelectorAll('[data-screens-dropdown]').forEach(function (group) {
      var trigger = group.querySelector('.screens-trigger');
      var menu    = group.querySelector('.screens-menu');
      if (!trigger || !menu) return;

      function close() {
        menu.setAttribute('hidden', '');
        trigger.setAttribute('aria-expanded', 'false');
        document.removeEventListener('mousedown', onOutside);
        document.removeEventListener('keydown', onKey);
      }
      function onOutside(e) { if (!group.contains(e.target)) close(); }
      function onKey(e)     { if (e.key === 'Escape') close(); }

      trigger.addEventListener('click', function (e) {
        e.stopPropagation();
        var isOpen = !menu.hasAttribute('hidden');
        if (isOpen) { close(); return; }
        menu.removeAttribute('hidden');
        trigger.setAttribute('aria-expanded', 'true');
        // Defer outside-listener registration past the current click event
        setTimeout(function () {
          document.addEventListener('mousedown', onOutside);
          document.addEventListener('keydown', onKey);
        }, 0);
      });
    });
  }

  function controlsHTML(opts) {
    opts = opts || {};
    var leftSide  = themeSeg() + modeSeg() + densitySeg();
    if (opts.workspace) leftSide += workspaceSeg();
    // Screen-specific extras live between the universal left side and the
    // right-aligned (Dock/Screens) cluster. Pass an HTML string of one or
    // more `.control-group` elements.
    if (opts.extras) leftSide += opts.extras;

    var rightSide = '';
    if (opts.dock) rightSide += dockSeg();
    rightSide += screensSeg(opts.current);

    // The first right-side group gets margin-left:auto, pushing the cluster
    // to the right edge of the bar. Apply via inline style on the wrapping
    // group — keeping the CSS class footprint zero so we don't fight specificity.
    rightSide = rightSide.replace(/<div class="control-group"/, '<div class="control-group" style="margin-left:auto;"');

    return leftSide + rightSide;
  }

  /* --- Segment binder ---------------------------------------------- */
  function bindSeg(el, attr) {
    if (!el) return;
    el.querySelectorAll('button[data-val], a[data-val]').forEach(function (b) {
      b.classList.toggle('is-on', b.dataset.val === html.getAttribute(attr));
    });
    el.addEventListener('click', function (e) {
      var b = e.target.closest('[data-val]');
      if (!b || b.tagName === 'A') return;
      el.querySelectorAll('[data-val]').forEach(function (x) { x.classList.remove('is-on'); });
      b.classList.add('is-on');
      html.setAttribute(attr, b.dataset.val);
      localStorage.setItem('ikenga-' + attr, b.dataset.val);
      window.dispatchEvent(new CustomEvent('ikenga:change', { detail: { attr: attr, value: b.dataset.val } }));
    });
  }

  function bindControls(scope) {
    var root = scope || document;
    bindSeg(root.querySelector('#seg-theme'),     'data-theme');
    bindSeg(root.querySelector('#seg-mode'),      'data-mode');
    bindSeg(root.querySelector('#seg-density'),   'data-density');
    bindSeg(root.querySelector('#seg-workspace'), 'data-workspace');
    // Note: #seg-dock is intentionally NOT bound here — dock state is page-local
    // (lives in localStorage 'ikenga-dock-state', re-rendered by the page's
    // own render() function). Each screen wires its own listener.
  }

  /* --- Public API -------------------------------------------------- */
  window.Ikenga = window.Ikenga || {};
  window.Ikenga.bindControls = bindControls;

  window.Controls = window.Controls || {};
  window.Controls.mount = function (el, opts) {
    if (!el) return;
    el.classList.add('controls');
    el.innerHTML = controlsHTML(opts);
    bindControls(el);
    bindScreensDropdowns(el);
  };

  /* --- Auto-mount any [data-controls-bar] slots, synchronously ----- */
  function autoMount() {
    document.querySelectorAll('[data-controls-bar]').forEach(function (el) {
      window.Controls.mount(el, {
        dock:      el.dataset.showDock === '1',
        workspace: el.dataset.showWorkspace === '1',
        current:   el.dataset.current || null
      });
    });
  }
  autoMount();
})();
