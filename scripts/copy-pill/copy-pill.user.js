// ==UserScript==
// @name         Copy Pill
// @namespace    shahzeb.tools
// @version      4.1.0
// @description  A Copy button appears by any text you select, plus Open when the selection contains a link — real hyperlinks as well as URLs written out in the text. Also unblocks pages that disable selection and copying.
// @match        *://*/*
// @run-at       document-start
// @grant        GM_setClipboard
// @grant        GM_openInTab
// @grant        unsafeWindow
// @homepageURL  https://github.com/umershahzeb02/bumbletap
// @supportURL   https://github.com/umershahzeb02/bumbletap/issues
// @downloadURL  https://raw.githubusercontent.com/umershahzeb02/bumbletap/master/scripts/copy-pill/copy-pill.user.js
// @updateURL    https://raw.githubusercontent.com/umershahzeb02/bumbletap/master/scripts/copy-pill/copy-pill.user.js
// ==/UserScript==

// WHY THERE ARE @grant LINES
// With "@grant none" a userscript is injected into the page context, where a
// strict script-src CSP can refuse to run it. Declaring any grant moves the
// script into Tampermonkey's own sandbox, which the page's CSP does not govern,
// so this runs on locked-down sites where a granted-none script silently would
// not. GM_setClipboard and GM_openInTab also go through the extension rather
// than the page, so they survive denied clipboard permissions and popup blockers.
//
// The tradeoff: in the sandbox, `window` is a proxy. Listeners still see real
// page events, but patching a prototype has to target unsafeWindow, or it only
// patches the sandbox's own copy and does nothing to the page.

(() => {
  'use strict';
  if (window.__copyPill) return;
  window.__copyPill = true;

  const W = (typeof unsafeWindow !== 'undefined' && unsafeWindow) ? unsafeWindow : window;

  // =====================================================================
  // Finding a link inside the selection
  // =====================================================================

  // Bare domains are deliberately restricted to a known TLD list. Matching any
  // word.word would turn "Node.js", "array.map" and "notes.txt" into links.
  const TLD = 'com|org|net|io|dev|ai|co|edu|gov|app|me|xyz|info|biz|uk|pk|de|fr|jp|cn|ru|br|in|au|ca|nl|se|no|es|it|ch|be|at|pl|cz|gr|pt|dk|fi|ie|nz|za|sg|hk|kr|tw|mx|ar|cl|tr|il|ae|sa';
  const URL_RE = new RegExp(
    '(https?:\\/\\/[^\\s<>"\'`\\[\\]{}|\\\\^]+)' +          // explicit scheme
    '|(www\\.[^\\s<>"\'`\\[\\]{}|\\\\^]+)' +                 // www. prefix
    '|([a-z0-9][a-z0-9-]*(?:\\.[a-z0-9-]+)*\\.(?:' + TLD + ')(?:\\/[^\\s<>"\'`\\[\\]{}|\\\\^]*)?)',
    'i'
  );

  function findUrl(text) {
    if (!text) return null;
    const m = URL_RE.exec(text);
    if (!m) return null;
    let raw = m[0];

    // Sentence punctuation clings to the end of a pasted link. Closing brackets
    // are only trimmed when unbalanced, so wiki-style URLs ending in "(disambiguation)"
    // survive intact.
    raw = raw.replace(/[.,;:!?'"]+$/, '');
    while (/[)\]]$/.test(raw)) {
      const open = (raw.match(/[([]/g) || []).length;
      const close = (raw.match(/[)\]]/g) || []).length;
      if (close <= open) break;
      raw = raw.slice(0, -1);
    }
    if (!raw) return null;

    const href = /^https?:\/\//i.test(raw) ? raw : 'https://' + raw;
    try {
      const u = new URL(href);
      if (!u.hostname || u.hostname.indexOf('.') === -1) return null;
      // Same shape as usableHref() returns, count included — both feed the same
      // pendingUrl, so they must not disagree about what that object looks like.
      return { href: u.href, host: u.hostname.replace(/^www\./, ''), count: 1 };
    } catch (e) {
      return null;
    }
  }

  // ---------------------------------------------------------------------
  // Real hyperlinks, read out of the DOM
  //
  // This is the case that matters on a page like Wikipedia. The selected text
  // reads "Alan Turing" and the destination exists only as an href, so no
  // amount of parsing the string will ever find it. The DOM is therefore
  // checked FIRST, and when both a real link and a written-out URL are present
  // the href wins: visible link text is free to disagree with where the link
  // actually goes, and the true destination is both the more useful and the
  // safer thing to show.
  // ---------------------------------------------------------------------

  function usableHref(a) {
    // The .href property rather than getAttribute(): the property resolves a
    // relative path against the document base, and keeps doing so on a
    // detached clone, whereas the attribute would hand back "/wiki/Foo".
    let href = '';
    try { href = a.href || ''; } catch (e) {}
    // Anything that is not http(s) is not something to open in a tab —
    // this is what drops javascript:, mailto:, tel: and blob: hrefs.
    if (!/^https?:\/\//i.test(href)) return null;
    // A jump to a heading or a footnote on the page you are already reading is
    // not a destination. Wikipedia articles are made of these.
    const here = String(location.href).split('#')[0];
    if (href.indexOf('#') !== -1 && href.split('#')[0] === here) return null;
    try {
      const u = new URL(href);
      return { href: u.href, host: u.hostname.replace(/^www\./, ''), count: 1 };
    } catch (e) {
      return null;
    }
  }

  function linkFromSelection(sel) {
    let range;
    try { range = sel.getRangeAt(0); } catch (e) { return null; }

    const anchors = [];

    // Case 1: the selection sits entirely inside one link. cloneContents()
    // would return a bare text node here, with no element left to read an href
    // from, so the enclosing anchor has to come off the ancestor chain.
    let node = range.commonAncestorContainer;
    if (node && node.nodeType !== 1) node = node.parentNode;
    if (node && node.closest) {
      const a = node.closest('a[href]');
      if (a) anchors.push(a);
    }

    // Case 2: the selection spans links. A partially covered anchor still
    // clones as a partial element carrying its href, so this also catches a
    // drag that starts or ends in the middle of a link.
    if (!anchors.length) {
      let frag = null;
      try { frag = range.cloneContents(); } catch (e) {}
      if (frag) {
        const list = frag.querySelectorAll('a[href]');
        for (let i = 0; i < list.length; i++) anchors.push(list[i]);
      }
    }

    // Deduplicated so the count reported below is honest — the same reference
    // linked twice in a paragraph is one destination, not two.
    const seen = Object.create(null);
    const urls = [];
    for (let i = 0; i < anchors.length; i++) {
      const u = usableHref(anchors[i]);
      if (u && !seen[u.href]) { seen[u.href] = 1; urls.push(u); }
    }
    if (!urls.length) return null;
    urls[0].count = urls.length;
    return urls[0];
  }

  // =====================================================================
  // The pill
  // =====================================================================

  let host = null, shadow = null, wrap = null;
  let copyBtn = null, copyLabel = null, openBtn = null, openLabel = null, sep = null;
  let pending = '', pendingUrl = null;

  const PILL_CSS = [
    ':host{all:initial}',
    '.w{display:flex;align-items:stretch;height:32px;background:#1d2226;',
    'border-radius:16px;box-shadow:0 4px 16px rgba(0,0,0,.4);',
    'border:1px solid rgba(255,255,255,.12);overflow:hidden;',
    'font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;',
    'font-size:12px;font-weight:600;line-height:1;user-select:none;white-space:nowrap}',
    '.b{display:flex;align-items:center;gap:6px;padding:0 12px;color:#fff;',
    'cursor:pointer;transition:background .12s}',
    '.b:hover{background:#2a3138}',
    '.b:active{background:#333c44}',
    '.b.done{background:#1f7a4d}',
    '.sep{width:1px;background:rgba(255,255,255,.14);flex:0 0 auto}',
    '.hidden{display:none}',
    'svg{width:13px;height:13px;flex:0 0 auto}'
  ].join('');

  const COPY_ICON = [
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ',
    'stroke-linecap="round" stroke-linejoin="round">',
    '<rect x="9" y="9" width="13" height="13" rx="2"></rect>',
    '<path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>',
    '</svg>'
  ].join('');

  const OPEN_ICON = [
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ',
    'stroke-linecap="round" stroke-linejoin="round">',
    '<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path>',
    '<polyline points="15 3 21 3 21 9"></polyline>',
    '<line x1="10" y1="14" x2="21" y2="3"></line>',
    '</svg>'
  ].join('');

  function makeBtn(icon, text) {
    const b = document.createElement('div');
    b.className = 'b';
    b.innerHTML = icon + '<span>' + text + '</span>';
    // mousedown must not reach the page: its default would drop the selection
    // before the click lands, leaving nothing to act on.
    b.addEventListener('mousedown', function (e) {
      e.preventDefault();
      e.stopPropagation();
    }, true);
    return b;
  }

  function build() {
    if (host || !document.body) return;
    host = document.createElement('div');
    host.style.cssText = 'all:initial;position:absolute;z-index:2147483647;display:none';

    // Shadow DOM so the page's stylesheets cannot reach in and restyle or hide
    // the pill. On the sites this exists for, that is a real risk.
    shadow = host.attachShadow({ mode: 'closed' });

    const style = document.createElement('style');
    style.textContent = PILL_CSS;

    wrap = document.createElement('div');
    wrap.className = 'w';

    copyBtn = makeBtn(COPY_ICON, 'Copy');
    copyLabel = copyBtn.querySelector('span');
    copyBtn.addEventListener('click', function (e) {
      e.preventDefault(); e.stopPropagation();
      copy(pending);
    }, true);

    sep = document.createElement('div');
    sep.className = 'sep hidden';

    openBtn = makeBtn(OPEN_ICON, 'Open');
    openLabel = openBtn.querySelector('span');
    openBtn.classList.add('hidden');
    openBtn.addEventListener('click', function (e) {
      e.preventDefault(); e.stopPropagation();
      openLink();
    }, true);

    wrap.appendChild(copyBtn);
    wrap.appendChild(sep);
    wrap.appendChild(openBtn);
    shadow.appendChild(style);
    shadow.appendChild(wrap);
    document.body.appendChild(host);
  }

  function show(text, rect, url) {
    build();
    if (!host) return;
    pending = text;
    pendingUrl = url;

    copyBtn.classList.remove('done');
    copyLabel.textContent = 'Copy';

    if (pendingUrl) {
      // The host is shown rather than the full URL: it identifies the
      // destination without letting a long link stretch the pill off-screen.
      openLabel.textContent = pendingUrl.host.length > 22
        ? pendingUrl.host.slice(0, 21) + '…'
        : pendingUrl.host;
      openBtn.title = pendingUrl.count > 1
        ? pendingUrl.href + '\n(first of ' + pendingUrl.count + ' links in the selection)'
        : pendingUrl.href;
      openBtn.classList.remove('hidden');
      sep.classList.remove('hidden');
    } else {
      openBtn.classList.add('hidden');
      sep.classList.add('hidden');
    }

    host.style.display = 'block';

    // Measured only once visible, then placed above the selection, flipping
    // below when there is no room at the top of the viewport.
    const w = host.offsetWidth || 92;
    const h = host.offsetHeight || 32;
    let top = rect.top + W.scrollY - h - 8;
    if (rect.top < h + 12) top = rect.bottom + W.scrollY + 8;
    let left = rect.left + W.scrollX + rect.width / 2 - w / 2;
    const maxLeft = W.scrollX + document.documentElement.clientWidth - w - 6;
    left = Math.max(6 + W.scrollX, Math.min(left, maxLeft));
    host.style.top = top + 'px';
    host.style.left = left + 'px';
  }

  function hide() {
    if (host) host.style.display = 'none';
    pending = '';
    pendingUrl = null;
  }

  // =====================================================================
  // Actions
  // =====================================================================

  function done() {
    copyBtn.classList.add('done');
    copyLabel.textContent = 'Copied';
    setTimeout(hide, 700);
  }

  function copy(text) {
    if (!text) return;
    // GM first: it goes through the extension, so it works on plain http pages
    // and wherever the page's own clipboard permission is denied.
    if (typeof GM_setClipboard === 'function') {
      try { GM_setClipboard(text, 'text'); done(); return; } catch (e) {}
    }
    if (navigator.clipboard && W.isSecureContext) {
      navigator.clipboard.writeText(text).then(done, function () {
        if (legacy(text)) done();
      });
      return;
    }
    if (legacy(text)) done();
  }

  function legacy(text) {
    // A temporary textarea steals the selection, so the ranges are saved and
    // restored — otherwise the highlight vanishes every time you copy.
    const sel = window.getSelection();
    const saved = [];
    for (let i = 0; i < sel.rangeCount; i++) saved.push(sel.getRangeAt(i).cloneRange());

    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;top:-9999px;left:-9999px;opacity:0';
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch (e) {}
    ta.remove();

    sel.removeAllRanges();
    saved.forEach(function (r) { sel.addRange(r); });
    return ok;
  }

  function openLink() {
    if (!pendingUrl) return;
    const href = pendingUrl.href;
    // GM_openInTab is not subject to the popup blocker. window.open is the
    // fallback, with noopener so the new tab cannot reach back through
    // window.opener and navigate this one.
    if (typeof GM_openInTab === 'function') {
      try { GM_openInTab(href, { active: true, insert: true }); hide(); return; } catch (e) {}
    }
    try { window.open(href, '_blank', 'noopener,noreferrer'); } catch (e) {}
    hide();
  }

  // =====================================================================
  // When the pill appears
  // =====================================================================

  function check() {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed) { hide(); return; }
    const text = String(sel);
    if (!text.trim()) { hide(); return; }
    let rect;
    try { rect = sel.getRangeAt(0).getBoundingClientRect(); } catch (e) { hide(); return; }
    if (!rect || (!rect.width && !rect.height)) { hide(); return; }
    show(text, rect, linkFromSelection(sel) || findUrl(text));
  }

  // Deferred a tick: at mouseup the selection is not final yet, and a
  // double-click's word selection lands after the event.
  function soon() { setTimeout(check, 0); }

  document.addEventListener('mouseup', soon, true);
  document.addEventListener('dblclick', soon, true);
  document.addEventListener('keyup', function (e) {
    const k = (e.key || '').toLowerCase();
    if (e.shiftKey || ((e.ctrlKey || e.metaKey) && k === 'a')) soon();
  }, true);
  document.addEventListener('mousedown', function (e) {
    // Clicks inside a shadow root retarget to the host, so this correctly
    // leaves the pill alone while dismissing on any outside click.
    if (host && e.target !== host) hide();
  }, true);
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') hide();
  }, true);
  window.addEventListener('scroll', function () { if (pending) soon(); }, true);

  // =====================================================================
  // Unblock pages that prevent selection or copying
  // =====================================================================

  const BLOCKED = ['copy', 'cut', 'contextmenu', 'selectstart', 'select', 'dragstart', 'beforecopy'];

  const UNBLOCK_CSS = [
    '*,*::before,*::after{',
    '-webkit-user-select:text !important;-moz-user-select:text !important;',
    '-ms-user-select:text !important;user-select:text !important;',
    '-webkit-touch-callout:default !important}',
    '::selection{background:Highlight !important;color:HighlightText !important}'
  ].join('');

  function addStyle() {
    if (document.getElementById('__cp_style')) return;
    const s = document.createElement('style');
    s.id = '__cp_style';
    s.textContent = UNBLOCK_CSS;
    (document.head || document.documentElement).appendChild(s);
  }
  addStyle();

  // Capture on window fires before anything the page attached to document or an
  // element, so the page's preventDefault() is never reached.
  BLOCKED.forEach(function (t) {
    window.addEventListener(t, function (e) { e.stopImmediatePropagation(); }, true);
  });

  // Only the clipboard chords, so the site's own shortcuts still work.
  window.addEventListener('keydown', function (e) {
    if (!(e.ctrlKey || e.metaKey)) return;
    const k = (e.key || '').toLowerCase();
    if (k === 'c' || k === 'x' || k === 'a' || k === 'v') e.stopImmediatePropagation();
  }, true);

  const PROPS = BLOCKED.map(function (t) { return 'on' + t; });

  function scrub(root) {
    [document, document.documentElement, document.body].forEach(function (t) {
      if (!t) return;
      PROPS.forEach(function (p) {
        if (p in t && t[p]) { try { t[p] = null; } catch (e) {} }
      });
    });
    const q = '[oncopy],[oncut],[oncontextmenu],[onselectstart],[ondragstart]';
    (root || document).querySelectorAll(q).forEach(function (el) {
      PROPS.forEach(function (p) { if (el.hasAttribute(p)) el.removeAttribute(p); });
    });
  }

  // Patch the PAGE's prototype, not the sandbox's copy. See the header note.
  try {
    const proto = W.EventTarget && W.EventTarget.prototype;
    if (proto) {
      const orig = proto.addEventListener;
      proto.addEventListener = function (type, fn, opts) {
        if (BLOCKED.indexOf(String(type).toLowerCase()) !== -1) return;
        return orig.call(this, type, fn, opts);
      };
    }
  } catch (e) {}

  function start() {
    build();
    scrub();
    new MutationObserver(function (muts) {
      addStyle();
      muts.forEach(function (m) {
        Array.prototype.forEach.call(m.addedNodes, function (n) {
          if (n.nodeType === 1) scrub(n);
        });
      });
    }).observe(document.documentElement, { childList: true, subtree: true });
  }

  if (document.body) start();
  else document.addEventListener('DOMContentLoaded', start, { once: true });

  try { console.info('[copy-pill] active — select text for Copy, plus Open when it contains a link'); } catch (e) {}
})();
