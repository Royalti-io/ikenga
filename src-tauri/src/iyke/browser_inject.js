// In-page helper for the pkg-browser MCP.
//
// Installed once per child-webview-page by `WebviewPanesRegistry::eval()`
// (the kernel-only eval surface). Exposes `window.__ikengaPkgBrowser` with
// snapshot + interaction helpers, plus a `sendReply(port, request_id,
// oneshot_token, body)` that posts results back to the shell's
// `/iyke/browser/_reply` endpoint.
//
// Refs (e0, e1, …) are stable within one snapshot. They invalidate when a
// new snapshot is taken or the document changes (e.g. SPA route change
// observed via MutationObserver). The MCP layer is expected to re-snapshot
// after any wait_for / navigation. Stale refs throw a structured error.
//
// SECURITY: no tokens are stored on window. Each Rust eval bakes the
// per-request oneshot_token into a closure that's discarded once the
// fetch resolves. Partner-site JS cannot read tokens or impersonate
// replies for in-flight requests.

(function () {
  if (window.__ikengaPkgBrowser && window.__ikengaPkgBrowser.__v === 1) {
    return; // idempotent — eval may inject multiple times
  }

  const IPB = {
    __v: 1,
    snapshotId: 0,
    /** Map<string, WeakRef<Element>> — current snapshot's ref → element. */
    refMap: new Map(),
    /** Track url at last snapshot so we can detect stale refs across SPA navs. */
    snapshotUrl: '',

    // ────────────────────────────────────────────────────────────────────
    // Reply transport
    // ────────────────────────────────────────────────────────────────────

    async sendReply(port, requestId, oneshotToken, body) {
      // Preferred path: Tauri IPC. Works for child webviews on arbitrary
      // remote origins (partner portals etc.) because Tauri's IPC channel
      // is exempt from CORS / mixed-content / Private Network Access. The
      // origin is allowlisted via the `pkg-browser-child` capability;
      // spoofing is gated by the per-request `oneshotToken` on the Rust
      // side. We try this first and only fall back to the HTTP route if
      // the IPC bridge isn't installed (e.g. unusual build config where
      // __TAURI_INTERNALS__ isn't injected) or the invoke itself fails.
      const internals = window.__TAURI_INTERNALS__;
      if (internals && typeof internals.invoke === 'function') {
        try {
          await internals.invoke('iyke_browser_reply', {
            request_id: requestId,
            oneshot_token: oneshotToken,
            ok: !!body.ok,
            payload: body.payload === undefined ? null : body.payload,
            error: body.error === undefined ? null : body.error,
          });
          return;
        } catch (_) {
          // fall through to HTTP fallback below
        }
      }
      try {
        await fetch(`http://127.0.0.1:${port}/iyke/browser/_reply`, {
          method: 'POST',
          mode: 'cors',
          credentials: 'omit',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            request_id: requestId,
            oneshot_token: oneshotToken,
            ...body,
          }),
        });
      } catch (_) {
        // If both transports fail, the shell-side request will time out
        // and surface the error — nothing useful to do here.
      }
    },

    // ────────────────────────────────────────────────────────────────────
    // Snapshot
    // ────────────────────────────────────────────────────────────────────

    /**
     * Walk the live DOM, emit a flat list of {ref, role, name, value, ...}
     * plus a Playwright-style indented `text` rendering. Includes a fresh
     * `snapshotId`; the ref map is replaced atomically at the end.
     */
    snapshot(opts) {
      opts = opts || {};
      const query = (opts.query || '').toLowerCase();
      const all = !!opts.all;
      const newRefMap = new Map();
      const nodes = [];
      const nodeByRef = new Map();
      const textLines = [];
      let refSeq = 0;

      visit(document.documentElement, 0);

      const id = ++this.snapshotId;
      this.refMap = newRefMap;
      this.snapshotUrl = window.location.href;

      const filtered = query
        ? nodes.filter(
            (n) =>
              (n.role && n.role.toLowerCase().includes(query)) ||
              (n.name && n.name.toLowerCase().includes(query)) ||
              (n.value && n.value.toLowerCase().includes(query)),
          )
        : nodes;

      return {
        url: window.location.href,
        title: document.title || '',
        text: textLines.join('\n'),
        nodes: filtered,
        snapshotId: id,
      };

      function visit(el, depth) {
        if (!(el instanceof Element)) return null;
        const visible = isVisible(el);
        if (!all && !visible) return null;

        const role = roleOf(el);
        const name = accessibleNameOf(el);
        const value = valueOf(el);
        const skip = !role && !name && !value && !isStructural(el);
        let myRef = null;

        if (!skip) {
          myRef = 'e' + refSeq++;
          newRefMap.set(myRef, new WeakRef(el));
          const entry = { ref: myRef, role: role || el.tagName.toLowerCase() };
          if (name) entry.name = name;
          if (value !== '' && value !== null && value !== undefined) {
            entry.value = String(value);
          }
          entry.tag = el.tagName.toLowerCase();
          if ('checked' in el && (el.type === 'checkbox' || el.type === 'radio')) {
            entry.checked = !!el.checked;
          } else if (el.getAttribute('aria-checked') === 'true') {
            entry.checked = true;
          }
          if (el.hasAttribute('disabled') || el.getAttribute('aria-disabled') === 'true') {
            entry.disabled = true;
          }
          if (el.getAttribute('aria-expanded') === 'true') entry.expanded = true;
          if (el.getAttribute('aria-selected') === 'true') entry.selected = true;
          if (!visible) entry.hidden = true;
          nodes.push(entry);
          nodeByRef.set(myRef, entry);
          textLines.push(indent(depth) + formatNode(entry, role || entry.tag));
        }

        const childRefs = [];
        for (let i = 0; i < el.children.length; i++) {
          const childRef = visit(el.children[i], myRef ? depth + 1 : depth);
          if (childRef && myRef) childRefs.push(childRef);
        }
        if (myRef && childRefs.length) {
          nodeByRef.get(myRef).children = childRefs;
        }
        return myRef;
      }
    },

    // ────────────────────────────────────────────────────────────────────
    // Ref resolution
    // ────────────────────────────────────────────────────────────────────

    /** Resolve a ref string to its live element, or null if stale. */
    resolveRef(ref) {
      const wr = this.refMap.get(ref);
      if (!wr) return null;
      const el = wr.deref();
      if (!el || !el.isConnected) return null;
      return el;
    },

    /** Resolve a target spec: ref > selector > text. Returns Element or throws. */
    resolveTarget(spec) {
      if (spec.ref) {
        const el = this.resolveRef(spec.ref);
        if (!el) throw new Error(`stale ref: ${spec.ref}`);
        return el;
      }
      if (spec.selector) {
        const el = document.querySelector(spec.selector);
        if (!el) throw new Error(`no element matches selector: ${spec.selector}`);
        return el;
      }
      if (spec.text) {
        const target = spec.text.toLowerCase();
        const candidates = document.querySelectorAll(
          'a, button, [role="button"], [role="link"], summary, label, input[type="submit"], input[type="button"]',
        );
        for (const el of candidates) {
          if ((el.textContent || el.value || '').toLowerCase().includes(target)) {
            return el;
          }
        }
        throw new Error(`no clickable element contains text: ${spec.text}`);
      }
      throw new Error('must specify one of: ref, selector, text');
    },

    // ────────────────────────────────────────────────────────────────────
    // Interactions (fire-and-forget from Rust's perspective)
    // ────────────────────────────────────────────────────────────────────

    click(spec) {
      const el = this.resolveTarget(spec);
      el.scrollIntoView({ block: 'center', inline: 'center' });
      const rect = el.getBoundingClientRect();
      const init = { bubbles: true, cancelable: true, view: window, clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 };
      el.dispatchEvent(new MouseEvent('mousedown', init));
      el.dispatchEvent(new MouseEvent('mouseup', init));
      el.dispatchEvent(new MouseEvent('click', init));
      return { ok: true };
    },

    fill(spec, text, replace) {
      const el = this.resolveTarget(spec);
      if (!('value' in el) && !el.isContentEditable) {
        throw new Error('target is not an input/textarea/contenteditable');
      }
      el.focus();
      if (el.isContentEditable) {
        if (replace) el.textContent = text;
        else el.textContent = (el.textContent || '') + text;
      } else {
        const setter = Object.getOwnPropertyDescriptor(
          Object.getPrototypeOf(el),
          'value',
        )?.set;
        const newVal = replace ? text : (el.value || '') + text;
        if (setter) setter.call(el, newVal);
        else el.value = newVal;
      }
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return { ok: true };
    },

    select(spec, value) {
      const el = this.resolveTarget(spec);
      if (!(el instanceof HTMLSelectElement)) {
        throw new Error('target is not a <select>');
      }
      let matched = false;
      for (const opt of el.options) {
        if (opt.value === value || opt.label === value || opt.text === value) {
          opt.selected = true;
          matched = true;
        } else {
          opt.selected = false;
        }
      }
      if (!matched) throw new Error(`no option with value or label: ${value}`);
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return { ok: true };
    },

    pressKey(spec, combo) {
      const parts = combo.split(/[+,]/).map((s) => s.trim()).filter(Boolean);
      const modifiers = {
        ctrlKey: false, altKey: false, shiftKey: false, metaKey: false,
      };
      let key = '';
      for (const p of parts) {
        const lc = p.toLowerCase();
        if (lc === 'ctrl' || lc === 'control') modifiers.ctrlKey = true;
        else if (lc === 'alt') modifiers.altKey = true;
        else if (lc === 'shift') modifiers.shiftKey = true;
        else if (lc === 'meta' || lc === 'cmd' || lc === 'command') modifiers.metaKey = true;
        else key = p;
      }
      if (!key) throw new Error(`no key in combo: ${combo}`);
      const target = spec && (spec.ref || spec.selector) ? this.resolveTarget(spec) : (document.activeElement || document.body);
      const init = { bubbles: true, cancelable: true, key, code: key, ...modifiers };
      target.dispatchEvent(new KeyboardEvent('keydown', init));
      target.dispatchEvent(new KeyboardEvent('keyup', init));
      return { ok: true };
    },

    readText(ref) {
      const el = this.resolveRef(ref);
      if (!el) throw new Error(`stale ref: ${ref}`);
      const text = el.innerText || el.textContent || el.value || '';
      return { text };
    },

    // ────────────────────────────────────────────────────────────────────
    // wait_for
    // ────────────────────────────────────────────────────────────────────

    async waitFor(kind, value, timeoutMs) {
      const start = performance.now();
      const deadline = start + timeoutMs;
      while (performance.now() < deadline) {
        let matched = false;
        if (kind === 'url') {
          matched = window.location.href.includes(value);
        } else if (kind === 'text') {
          matched = (document.body.innerText || '').includes(value);
        } else if (kind === 'gone-text') {
          matched = !(document.body.innerText || '').includes(value);
        } else if (kind === 'selector') {
          matched = !!document.querySelector(value);
        } else if (kind === 'gone-selector') {
          matched = !document.querySelector(value);
        } else if (kind === 'ref') {
          // Re-snapshot quietly; check whether the requested ref id exists.
          const snap = this.snapshot({});
          matched = snap.nodes.some((n) => n.ref === value);
        } else if (kind === 'idle') {
          if (document.readyState === 'complete') {
            // Best-effort: also wait for ≥250ms of MO silence.
            const ok = await waitIdle(Math.min(500, deadline - performance.now()));
            matched = ok;
          }
        }
        if (matched) {
          return { satisfied: true, elapsed_ms: Math.round(performance.now() - start) };
        }
        await sleep(100);
      }
      return {
        satisfied: false,
        elapsed_ms: Math.round(performance.now() - start),
        message: `timed out waiting for ${kind}=${value || ''}`,
      };
    },
  };

  // ──────────────────────────────────────────────────────────────────────
  // Helpers
  // ──────────────────────────────────────────────────────────────────────

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  function waitIdle(maxMs) {
    return new Promise((resolve) => {
      let lastChange = performance.now();
      const obs = new MutationObserver(() => {
        lastChange = performance.now();
      });
      obs.observe(document.body, { childList: true, subtree: true, attributes: true });
      const start = performance.now();
      const tick = () => {
        const now = performance.now();
        if (now - lastChange >= 250) {
          obs.disconnect();
          resolve(true);
          return;
        }
        if (now - start >= maxMs) {
          obs.disconnect();
          resolve(false);
          return;
        }
        setTimeout(tick, 50);
      };
      tick();
    });
  }

  function isVisible(el) {
    if (el.hidden) return false;
    if (el.getAttribute('aria-hidden') === 'true') return false;
    const cs = window.getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') return false;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return false;
    return true;
  }

  function isStructural(el) {
    const t = el.tagName.toLowerCase();
    return t === 'main' || t === 'header' || t === 'footer' || t === 'nav' || t === 'section' || t === 'article' || t === 'form' || t === 'dialog';
  }

  function roleOf(el) {
    const explicit = el.getAttribute('role');
    if (explicit) return explicit;
    const t = el.tagName.toLowerCase();
    const map = {
      a: 'link',
      button: 'button',
      input: inputRole(el),
      select: 'combobox',
      textarea: 'textbox',
      h1: 'heading',
      h2: 'heading',
      h3: 'heading',
      h4: 'heading',
      h5: 'heading',
      h6: 'heading',
      img: 'img',
      nav: 'navigation',
      main: 'main',
      header: 'banner',
      footer: 'contentinfo',
      form: 'form',
      dialog: 'dialog',
      ul: 'list',
      ol: 'list',
      li: 'listitem',
      table: 'table',
      tr: 'row',
      td: 'cell',
      th: 'columnheader',
    };
    return map[t] || '';
  }

  function inputRole(el) {
    const t = (el.type || 'text').toLowerCase();
    if (t === 'checkbox') return 'checkbox';
    if (t === 'radio') return 'radio';
    if (t === 'submit' || t === 'button') return 'button';
    if (t === 'range') return 'slider';
    return 'textbox';
  }

  function accessibleNameOf(el) {
    return (
      el.getAttribute('aria-label') ||
      labelFor(el) ||
      el.getAttribute('alt') ||
      el.getAttribute('title') ||
      el.getAttribute('placeholder') ||
      shortText(el)
    );
  }

  function labelFor(el) {
    if (!el.id) return '';
    const lbl = document.querySelector(`label[for="${cssEscape(el.id)}"]`);
    return lbl ? (lbl.innerText || '').trim() : '';
  }

  function cssEscape(s) {
    return s.replace(/[^a-zA-Z0-9_-]/g, '\\$&');
  }

  function shortText(el) {
    const t = (el.innerText || el.textContent || '').trim();
    if (!t) return '';
    return t.length > 80 ? t.slice(0, 77) + '…' : t;
  }

  function valueOf(el) {
    if ('value' in el && typeof el.value === 'string') return el.value;
    return '';
  }

  function indent(n) {
    return '  '.repeat(n);
  }

  function formatNode(entry, role) {
    const bits = [role];
    if (entry.name) bits.push(JSON.stringify(entry.name));
    bits.push('[ref=' + entry.ref + ']');
    const flags = [];
    if (entry.checked) flags.push('checked');
    if (entry.disabled) flags.push('disabled');
    if (entry.expanded) flags.push('expanded');
    if (entry.selected) flags.push('selected');
    if (entry.hidden) flags.push('hidden');
    if (flags.length) bits.push('[' + flags.join(',') + ']');
    if (entry.value) bits.push('value=' + JSON.stringify(entry.value));
    return bits.join(' ');
  }

  window.__ikengaPkgBrowser = IPB;
})();
