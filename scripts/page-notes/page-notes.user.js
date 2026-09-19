// ==UserScript==
// @name         Page Notes
// @namespace    shahzeb.tools
// @version      1.2.0
// @description  Notes for every web page, kept per page. A pill in the top-right corner opens them; drag it anywhere. Built in a closed shadow root, so it never touches the page's styles.
// @match        *://*/*
// @noframes
// @run-at       document-start
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_listValues
// @grant        GM_addValueChangeListener
// @grant        GM_removeValueChangeListener
// @grant        GM_registerMenuCommand
// @homepageURL  https://github.com/umershahzeb02/bumbletap
// @supportURL   https://github.com/umershahzeb02/bumbletap/issues
// @downloadURL  https://raw.githubusercontent.com/umershahzeb02/bumbletap/master/scripts/page-notes/page-notes.user.js
// @updateURL    https://raw.githubusercontent.com/umershahzeb02/bumbletap/master/scripts/page-notes/page-notes.user.js
// ==/UserScript==

// Notes for the page you are on. Click the pill (or press Alt+N) and type.
// There is no save button and nothing to confirm; the notes are waiting the
// next time you open the same page.
//
// HOW IT STAYS OUT OF THE PAGE
// Everything is built inside a closed shadow root on one element appended to
// <html>. The page's stylesheets cannot reach in, and nothing leaks out:
// no <style> is added to the page, no page element is restyled, and the host
// is a 0x0 fixed box, so it takes no space in the layout. The host's own
// styles are set inline with `all: initial !important`, which outranks
// anything a stylesheet can say about it.
//
// Keystrokes are the other leak. An event from inside a shadow root reaches the
// page retargeted to the host, which is not an input, so a site's keyboard
// shortcuts would fire while you type a note: "/" jumps to GitHub's search,
// "k" pauses YouTube. Key and input events from the UI are therefore handled,
// then stopped, by a window capture listener installed at document-start,
// before the page's own listeners run. The keys still type: stopping
// propagation does not cancel the browser's default action.

(() => {
  'use strict';
  if (window.__pageNotes) return;
  window.__pageNotes = true;

  // =====================================================================
  // Storage
  // =====================================================================

  // Tampermonkey's storage, not the page's. localStorage belongs to the site:
  // its scripts can read it, and "clear site data" wipes it. GM storage is
  // private to this script and shared by every site, which is also what lets
  // the pill's position follow you from one site to the next.
  //
  // Without the GM functions (pasted into a console, say) it falls back to
  // namespaced localStorage. That works, but per site only, and the site can
  // read it.
  const HAS_GM = typeof GM_getValue === 'function' && typeof GM_setValue === 'function';
  const LS = '__page-notes:';

  const store = HAS_GM ? {
    get: function (k, d) {
      try { const v = GM_getValue(k); return v === undefined ? d : v; } catch (e) { return d; }
    },
    set: function (k, v) { try { GM_setValue(k, v); } catch (e) {} },
    del: function (k) { try { GM_deleteValue(k); } catch (e) {} },
    keys: function () { try { return GM_listValues() || []; } catch (e) { return []; } },
    watch: function (k, fn) {
      let id = null;
      try {
        if (typeof GM_addValueChangeListener === 'function') {
          id = GM_addValueChangeListener(k, function (name, was, now, remote) { if (remote) fn(now); });
        }
      } catch (e) {}
      return function () {
        try {
          if (id != null && typeof GM_removeValueChangeListener === 'function') GM_removeValueChangeListener(id);
        } catch (e) {}
      };
    }
  } : {
    get: function (k, d) {
      try { const v = localStorage.getItem(LS + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; }
    },
    set: function (k, v) { try { localStorage.setItem(LS + k, JSON.stringify(v)); } catch (e) {} },
    del: function (k) { try { localStorage.removeItem(LS + k); } catch (e) {} },
    keys: function () {
      const out = [];
      try {
        for (let i = 0; i < localStorage.length; i++) {
          const k = localStorage.key(i);
          if (k && k.indexOf(LS) === 0) out.push(k.slice(LS.length));
        }
      } catch (e) {}
      return out;
    },
    watch: function (k, fn) {
      const h = function (e) {
        if (e.key !== LS + k) return;
        try { fn(e.newValue == null ? undefined : JSON.parse(e.newValue)); } catch (x) {}
      };
      window.addEventListener('storage', h);
      return function () { window.removeEventListener('storage', h); };
    }
  };

  // =====================================================================
  // Which page is this?
  // =====================================================================

  // One page, one set of notes, so two URLs that show the same page must give
  // the same key. Tracking parameters are dropped and the rest are sorted. The
  // fragment is dropped too, unless it is a hash router's route (#/inbox). The
  // query is otherwise kept: on plenty of sites it IS the page (a search, a
  // product, a video).
  const TRACKING = /^(utm_[a-z]+|fbclid|gclid|dclid|gbraid|wbraid|msclkid|mc_cid|mc_eid|igshid|igsh|yclid|_hsenc|_hsmi|mkt_tok|ref_src|ref_url|si)$/i;

  function pageKey(href) {
    let u;
    try { u = new URL(href); } catch (e) { return String(href); }
    const site = u.host.replace(/^www\./, '');
    let params = [];
    u.searchParams.forEach(function (v, k) { if (!TRACKING.test(k)) params.push([k, v]); });
    // A YouTube watch page is its video. The timestamp, the playlist and the
    // search-tracking "pp" would otherwise scatter one video's notes.
    if (/(^|\.)youtube\.com$/.test(site) && u.pathname === '/watch') {
      params = params.filter(function (p) { return p[0] === 'v'; });
    }
    params.sort(function (a, b) { return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0; });
    const path = u.pathname.replace(/\/+$/, '') || '/';
    const query = params.length ? '?' + new URLSearchParams(params).toString() : '';
    const route = /^#!?\//.test(u.hash) ? u.hash : '';
    return site + path + query + route;
  }

  // Stored per page, under "note:<page key>":
  //   { url, title, blocks: [{ type, text, done }], created, updated }
  // A block is one paragraph, to-do, list item or heading, as in Notion.
  const NOTE = 'note:';
  const TYPES = ['p', 'h', 'h2', 'todo', 'ul', 'ol', 'quote', 'callout', 'code', 'hr'];
  const keyFor = function (href) { return NOTE + pageKey(href); };
  const siteKey = function (k) {
    const pk = k.slice(NOTE.length);
    const i = pk.indexOf('/');
    return i === -1 ? pk : pk.slice(0, i);
  };

  // =====================================================================
  // State
  // =====================================================================

  const M = 12;      // distance from the viewport edge
  const GAP = 8;     // between the pill and the panel
  const PILL = 32;   // pill height
  const EASE = 'cubic-bezier(.2, 0, 0, 1)';

  let pageHref = location.href;
  let key = keyFor(pageHref);
  let data = store.get(key, null);
  let dirty = false, saveTimer = 0;
  let unwatch = function () {};
  let isOpen = false, returnFocus = null;
  let pos = normPos(store.get('ui:pos', null));
  let drag = null, suppressClick = false, hovering = false;
  let peekTimer = 0, toastTimer = 0, undoFn = null;
  const HIDE_KEY = 'ui:hide:' + location.hostname;

  let host = null, shadow = null;
  let pill, pillCount, pillPeek, panel, fav, headTitle, headSub, delBtn, scroller, doc;
  let siteBox, siteToggle, siteLabel, siteList, toast, toastText, toastUndo;
  let menu, menuItems = [], menuIndex = 0, menuBlock = null, menuQuery = '';

  function normPos(p) {
    return p && (p.side === 'left' || p.side === 'right') && isFinite(p.y) ? p : { side: 'right', y: M };
  }

  // =====================================================================
  // Look
  // =====================================================================

  // Apple's neutrals and hairlines, with Notes' gold as the only accent, on
  // the caret, the selection and a finished to-do. The theme follows the
  // operating system, the way native panels do. (Not named CSS: that would
  // shadow the browser's CSS object, and CSS.supports() below with it.)
  const STYLE = `
.root {
  display: contents;
  --bg: rgba(250, 250, 252, .82);
  --solid: #fafafc;
  --fg: #1d1d1f;
  --fg2: #6e6e73;
  --fg3: #a1a1a6;
  --line: rgba(0, 0, 0, .08);
  --hover: rgba(0, 0, 0, .045);
  --press: rgba(0, 0, 0, .08);
  --accent: #d99c00;
  --on-accent: #fff;
  --focus: rgba(0, 113, 227, .6);
  --edge: rgba(0, 0, 0, .1);
  --float: 0 0 0 .5px rgba(0, 0, 0, .12), 0 1px 2px rgba(0, 0, 0, .08), 0 4px 14px rgba(0, 0, 0, .10);
  --lift: 0 0 0 .5px rgba(0, 0, 0, .12), 0 1px 2px rgba(0, 0, 0, .06), 0 16px 36px -8px rgba(0, 0, 0, .22);
  direction: ltr;
  font: 400 14px/1.5 -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI Variable Text", "Segoe UI", system-ui, Roboto, "Helvetica Neue", Arial, sans-serif;
  color: var(--fg);
  color-scheme: light;
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
  -webkit-text-size-adjust: 100%;
  text-size-adjust: 100%;
}
@media (prefers-color-scheme: dark) {
  .root {
    /* Denser than the light glass: at .8 over a light page it went muddy grey. */
    --bg: rgba(40, 40, 42, .9);
    --solid: #28282a;
    --fg: #f5f5f7;
    --fg2: #a1a1a6;
    --fg3: #6e6e73;
    --line: rgba(255, 255, 255, .09);
    --hover: rgba(255, 255, 255, .07);
    --press: rgba(255, 255, 255, .12);
    --accent: #ffd60a;
    --on-accent: #1d1d1f;
    --focus: rgba(41, 151, 255, .75);
    --edge: rgba(255, 255, 255, .1);
    --float: 0 0 0 .5px rgba(255, 255, 255, .14), 0 1px 2px rgba(0, 0, 0, .3), 0 4px 14px rgba(0, 0, 0, .4);
    --lift: 0 0 0 .5px rgba(255, 255, 255, .12), 0 1px 2px rgba(0, 0, 0, .3), 0 18px 44px -8px rgba(0, 0, 0, .6);
    color-scheme: dark;
  }
}
*, *::before, *::after { box-sizing: border-box; }
button { font: inherit; color: inherit; margin: 0; }
[hidden] { display: none !important; }

/* ---------- pill ---------- */
.pill {
  position: fixed;
  top: ${M}px;
  right: ${M}px;
  display: flex;
  flex-direction: row-reverse;   /* anchored right: it grows to the left */
  align-items: center;
  height: ${PILL}px;
  min-width: ${PILL}px;
  padding: 0 8px;
  border: 0;
  border-radius: ${PILL / 2}px;
  background: var(--bg);
  -webkit-backdrop-filter: blur(20px) saturate(180%);
  backdrop-filter: blur(20px) saturate(180%);
  box-shadow: var(--float);
  color: var(--fg);
  font-size: 12px;
  font-weight: 600;
  line-height: 1;
  font-variant-numeric: tabular-nums;
  cursor: pointer;
  user-select: none;
  -webkit-user-select: none;
  touch-action: none;
  -webkit-tap-highlight-color: transparent;
  pointer-events: auto;
  opacity: .72;
  transition-property: opacity, transform, box-shadow;
  transition-duration: .16s;
  transition-timing-function: ${EASE};
}
.pill.left { flex-direction: row; }
.pill:hover, .pill.has, .pill.open, .pill:focus-visible { opacity: 1; }
.pill:active { transform: scale(.96); }
.pill.dragging { cursor: grabbing; transform: scale(1.04); box-shadow: var(--lift); }
.pill.off { display: none; }
.pill svg { flex: 0 0 auto; display: block; }
.count { margin: 0 3px; }
.count:empty { display: none; }
.peek {
  max-width: 0;
  margin: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  line-height: 16px;
  font-weight: 500;
  color: var(--fg2);
  opacity: 0;
  transition: max-width .3s ${EASE}, margin .3s ${EASE}, opacity .2s ${EASE};
}
.pill.peeking .peek { max-width: 240px; margin: 0 6px; opacity: 1; }

/* ---------- panel ---------- */
.panel {
  position: fixed;
  top: ${M + PILL + GAP}px;
  right: ${M}px;
  width: 340px;
  max-width: calc(100vw - ${2 * M}px);
  max-height: 560px;
  display: flex;
  flex-direction: column;
  background: var(--bg);
  -webkit-backdrop-filter: blur(30px) saturate(180%);
  backdrop-filter: blur(30px) saturate(180%);
  border-radius: 16px;
  box-shadow: var(--lift);
  overflow: hidden;
  pointer-events: auto;
  transform-origin: top right;
  opacity: 0;
  transform: translateY(-4px) scale(.98);
  visibility: hidden;
  transition: opacity .14s ${EASE}, transform .14s ${EASE}, visibility 0s linear .14s;
}
.panel.open {
  opacity: 1;
  transform: none;
  visibility: visible;
  transition: opacity .2s ${EASE}, transform .2s ${EASE}, visibility 0s;
}
@supports not ((backdrop-filter: blur(1px)) or (-webkit-backdrop-filter: blur(1px))) {
  .pill, .panel { background: var(--solid); }
}

.head { display: flex; align-items: center; gap: 10px; padding: 10px 8px 6px 14px; }
.fav {
  flex: 0 0 auto;
  width: 16px;
  height: 16px;
  border-radius: 4px;
  outline: 1px solid var(--edge);
  outline-offset: -1px;
}
.meta { flex: 1 1 auto; min-width: 0; }
.title, .sub { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.title { font-size: 13px; font-weight: 600; line-height: 18px; }
.sub { font-size: 11.5px; line-height: 16px; color: var(--fg2); }
.btn {
  flex: 0 0 auto;
  display: grid;
  place-items: center;
  width: 28px;
  height: 28px;
  padding: 0;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: var(--fg2);
  cursor: pointer;
  transition-property: background-color, color, transform;
  transition-duration: .12s;
  transition-timing-function: ${EASE};
}
.btn:hover { background: var(--hover); color: var(--fg); }
.btn:active { background: var(--press); transform: scale(.96); }

/* One scroller for this page's notes and the rest of the site's, so the panel
   reads top to bottom as a single document. */
.body {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
  scrollbar-width: thin;
  scrollbar-color: var(--fg3) transparent;
}
.doc { min-height: 72px; padding: 4px 14px 16px; cursor: text; }
.block { display: flex; align-items: flex-start; gap: 8px; padding: 2px 0; }
.block[data-type="h"] { padding-top: 8px; }
.block[data-type="h"]:first-child { padding-top: 2px; }
.mark {
  flex: 0 0 auto;
  display: none;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 21px;
}
.block[data-type="ul"] .mark, .block[data-type="todo"] .mark, .block[data-type="ol"] .mark { display: flex; }
.num { justify-content: flex-end; font-size: 13px; color: var(--fg2); font-variant-numeric: tabular-nums; }
.block[data-type="ul"] .mark::before {
  content: "";
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: currentColor;
}
.check { cursor: pointer; }
.box {
  display: grid;
  place-items: center;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  box-shadow: inset 0 0 0 1.5px var(--fg3);
  color: var(--on-accent);
  transition: background-color .12s ${EASE}, box-shadow .12s ${EASE};
}
.box svg { opacity: 0; transition: opacity .12s ${EASE}; }
.block[data-done="1"] .box { background: var(--accent); box-shadow: none; }
.block[data-done="1"] .box svg { opacity: 1; }
textarea {
  flex: 1 1 auto;
  display: block;
  width: 100%;
  min-width: 0;
  min-height: 21px;
  margin: 0;
  padding: 0;
  border: 0;
  border-radius: 0;
  outline: 0;
  background: transparent;
  color: inherit;
  font: inherit;
  line-height: 21px;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  resize: none;
  overflow: hidden;
  field-sizing: content;
  caret-color: var(--accent);
}
textarea::placeholder { color: var(--fg3); opacity: 1; }
textarea::selection { background: color-mix(in srgb, var(--accent) 32%, transparent); }
.doc:not(.empty) textarea:not(:focus)::placeholder { color: transparent; }
.block[data-type="h"] textarea { font-size: 16px; font-weight: 600; line-height: 24px; letter-spacing: -.01em; }
.block[data-type="h"] .mark { height: 24px; }
.block[data-done="1"] textarea { color: var(--fg3); text-decoration: line-through; }
.block[data-type="h2"] { padding-top: 6px; }
.block[data-type="h2"] textarea { font-size: 14.5px; font-weight: 600; line-height: 22px; }
.block[data-type="quote"] { margin: 2px 0; padding-left: 12px; border-left: 2px solid var(--fg3); }
.block[data-type="quote"] textarea { color: var(--fg2); }
.block[data-type="callout"] {
  margin: 4px 0;
  padding: 6px 10px;
  border-radius: 8px;
  background: color-mix(in srgb, var(--accent) 16%, transparent);
}
.block[data-type="code"] { margin: 4px 0; padding: 7px 10px; border-radius: 8px; background: var(--hover); }
.block[data-type="code"] textarea {
  font: 12.5px/19px ui-monospace, "SF Mono", "Cascadia Code", Menlo, Consolas, monospace;
  tab-size: 2;
}
.block[data-type="hr"] { padding: 9px 0; }
.block[data-type="hr"] textarea {
  height: 1px !important;
  min-height: 1px;
  background: var(--line);
  color: transparent;
  caret-color: transparent;
  cursor: default;
}
.block[data-type="hr"] textarea:focus { background: var(--accent); }

/* The "/" menu, as in Notion. */
.menu {
  position: absolute;
  left: 12px;
  z-index: 2;
  width: 224px;
  max-height: 248px;
  padding: 4px;
  overflow-y: auto;
  overscroll-behavior: contain;
  border-radius: 12px;
  background: var(--solid);
  box-shadow: var(--lift);
}
.menu-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 6px 8px;
  border-radius: 8px;
  font-size: 13px;
  line-height: 18px;
  cursor: pointer;
}
.menu-item[aria-selected="true"] { background: var(--hover); }
.menu-hint { font: 11px/1 ui-monospace, "SF Mono", Menlo, Consolas, monospace; color: var(--fg3); }

.site { padding: 6px 6px 8px; border-top: 1px solid var(--line); }
.site-toggle {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: 6px 8px;
  border: 0;
  border-radius: 10px;
  background: transparent;
  color: var(--fg2);
  font-size: 12px;
  font-weight: 500;
  text-align: left;
  cursor: pointer;
  transition: background-color .12s ${EASE}, color .12s ${EASE};
}
.site-toggle:hover { background: var(--hover); color: var(--fg); }
.site-toggle svg { flex: 0 0 auto; transition: transform .2s ${EASE}; }
.site-toggle[aria-expanded="true"] svg { transform: rotate(90deg); }
/* Other pages' notes keep the look of a quiet list: soft rounded rows, a
   regular-weight title, the note itself in the secondary grey. */
.site-list { display: grid; gap: 2px; margin: 2px 0 0; padding: 0; list-style: none; }
.group { padding: 6px 8px 7px; border-radius: 10px; transition: background-color .12s ${EASE}; }
.group:hover { background: var(--hover); }
.group-head { display: flex; align-items: center; gap: 6px; }
.group-title {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  font-size: 13px;
  font-weight: 500;
  line-height: 18px;
}
.go {
  flex: 0 0 auto;
  display: grid;
  place-items: center;
  width: 22px;
  height: 22px;
  margin: -2px -4px -2px 0;
  border-radius: 6px;
  color: var(--fg3);
  text-decoration: none;
  transition-property: background-color, color, transform;
  transition-duration: .12s;
  transition-timing-function: ${EASE};
}
.group:hover .go { color: var(--fg2); }
.go:hover { background: var(--press); color: var(--fg); }
.go:active { transform: scale(.96); }
.ro { gap: 6px; padding: 0; color: var(--fg2); }
.ro .mark { width: 14px; height: 17px; }
.ro .box { width: 13px; height: 13px; }
.ro .num { font-size: 11.5px; }
.ro .text {
  flex: 1 1 auto;
  min-width: 0;
  font-size: 12px;
  line-height: 17px;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.ro[data-type="h"], .ro[data-type="h2"] { padding-top: 2px; }
.ro[data-type="h"] .text, .ro[data-type="h2"] .text { font-weight: 600; color: var(--fg); }
.ro[data-type="quote"] { margin: 1px 0; padding-left: 8px; }
.ro[data-type="callout"] { margin: 2px 0; padding: 3px 7px; border-radius: 6px; }
.ro[data-type="code"] { margin: 2px 0; padding: 4px 7px; border-radius: 6px; }
.ro[data-type="code"] .text { font: 11.5px/16px ui-monospace, "SF Mono", "Cascadia Code", Menlo, Consolas, monospace; }
.ro[data-type="hr"] { padding: 6px 0; }
.ro[data-type="hr"] .text { height: 1px; background: var(--line); }
.ro[data-done="1"] .text { color: var(--fg3); text-decoration: line-through; }

.toast {
  position: absolute;
  left: 50%;
  bottom: 12px;
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 5px 5px 5px 12px;
  border-radius: 12px;
  background: var(--fg);
  color: var(--solid);
  font-size: 12.5px;
  font-weight: 500;
  white-space: nowrap;
  box-shadow: 0 8px 24px rgba(0, 0, 0, .18);
  opacity: 0;
  visibility: hidden;
  transform: translate(-50%, 4px);
  transition: opacity .14s ${EASE}, transform .14s ${EASE}, visibility 0s linear .14s;
}
.toast.show {
  opacity: 1;
  visibility: visible;
  transform: translate(-50%, 0);
  transition: opacity .2s ${EASE}, transform .2s ${EASE}, visibility 0s;
}
.toast button {
  padding: 4px 10px;
  border: 0;
  border-radius: 7px;
  background: color-mix(in srgb, currentColor 16%, transparent);
  font-weight: 600;
  cursor: pointer;
  transition: background-color .12s ${EASE}, transform .12s ${EASE};
}
.toast button:hover { background: color-mix(in srgb, currentColor 24%, transparent); }
.toast button:active { transform: scale(.96); }

.pill:focus-visible, button:focus-visible, .go:focus-visible {
  outline: 2px solid var(--focus);
  outline-offset: 2px;
}

@media (prefers-reduced-motion: reduce) {
  .pill, .panel, .toast, .peek, .btn, .go, .box, .box svg, .site-toggle svg {
    transition-duration: 0s !important;
    transition-delay: 0s !important;
  }
  .panel { transform: none !important; }
  .toast { transform: translate(-50%, 0) !important; }
  .pill.dragging { transform: none; }
}
`;

  // Icons are drawn on a 16-unit grid. Stroke is in those units, so at 16px it
  // is also the rendered width: 1.5 beside regular text, 1.75 on the pill,
  // whose count is set in semibold.
  const I_NOTE = [['rect', { x: 2.75, y: 1.75, width: 10.5, height: 12.5, rx: 2.5 }], ['path', { d: 'M5.5 5.5h5M5.5 8h5M5.5 10.5h3' }]];
  const I_TRASH = [['path', { d: 'M2.75 4.25h10.5M6.25 4.25V3a.75.75 0 0 1 .75-.75h2a.75.75 0 0 1 .75.75v1.25M4.25 4.25l.55 8.3a1.25 1.25 0 0 0 1.25 1.2h3.9a1.25 1.25 0 0 0 1.25-1.2l.55-8.3' }]];
  const I_CLOSE = [['path', { d: 'M4.5 4.5l7 7M11.5 4.5l-7 7' }]];
  const I_CHEVRON = [['path', { d: 'M6 3.75L10.25 8 6 12.25' }]];
  const I_CHECK = [['path', { d: 'M4 8.4l2.5 2.4L12 5.2' }]];
  const I_GO = [['path', { d: 'M4.75 11.25l6.5-6.5M5.5 4.75h5.75v5.75' }]];

  const PLACEHOLDER = {
    p: 'Write, or type / for formatting', h: 'Heading', h2: 'Subheading', todo: 'To-do', ul: 'List',
    ol: 'List', quote: 'Quote', callout: 'Highlight', code: 'Code', hr: ''
  };

  // What the "/" menu offers, with the shortcut that does the same as you type.
  const FORMATS = [
    { type: 'p', label: 'Text', hint: '' },
    { type: 'h', label: 'Heading', hint: '#' },
    { type: 'h2', label: 'Subheading', hint: '##' },
    { type: 'todo', label: 'To-do', hint: '[]' },
    { type: 'ul', label: 'Bulleted list', hint: '-' },
    { type: 'ol', label: 'Numbered list', hint: '1.' },
    { type: 'quote', label: 'Quote', hint: '>' },
    { type: 'callout', label: 'Highlight', hint: '!' },
    { type: 'code', label: 'Code', hint: '```' },
    { type: 'hr', label: 'Divider', hint: '---' }
  ];
  const LEAD = 'Write a note about this page';

  // Built with DOM calls, never innerHTML: sites that enforce Trusted Types
  // throw on an innerHTML string, and note text must never be parsed as markup.
  const SVGNS = 'http://www.w3.org/2000/svg';
  function icon(spec, size, stroke) {
    const s = document.createElementNS(SVGNS, 'svg');
    const attrs = {
      viewBox: '0 0 16 16', width: size, height: size, fill: 'none', stroke: 'currentColor',
      'stroke-width': stroke, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true'
    };
    Object.keys(attrs).forEach(function (k) { s.setAttribute(k, attrs[k]); });
    spec.forEach(function (part) {
      const n = document.createElementNS(SVGNS, part[0]);
      Object.keys(part[1]).forEach(function (k) { n.setAttribute(k, part[1][k]); });
      s.appendChild(n);
    });
    return s;
  }

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function button(cls, label, glyph) {
    const b = el('button', cls);
    b.type = 'button';
    b.title = label;
    b.setAttribute('aria-label', label);
    if (glyph) b.appendChild(glyph);
    return b;
  }

  // =====================================================================
  // Building the UI
  // =====================================================================

  function build() {
    host = document.createElement('page-notes-root');
    const hs = host.style;
    [['all', 'initial'], ['position', 'fixed'], ['top', '0'], ['left', '0'], ['width', '0'],
     ['height', '0'], ['z-index', '2147483647'], ['display', 'block'], ['pointer-events', 'none']]
      .forEach(function (p) { hs.setProperty(p[0], p[1], 'important'); });

    shadow = host.attachShadow({ mode: 'closed' });
    const root = el('div', 'root');

    pill = button('pill', 'Notes for this page', icon(I_NOTE, 16, 1.75));
    pill.setAttribute('aria-expanded', 'false');
    pill.setAttribute('aria-controls', 'pn-panel');
    pill.removeAttribute('title');
    pillCount = el('span', 'count');
    pillPeek = el('span', 'peek');
    pill.append(pillCount, pillPeek);

    panel = el('div', 'panel');
    panel.id = 'pn-panel';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', 'Notes for this page');

    const head = el('div', 'head');
    fav = el('img', 'fav');
    fav.alt = '';
    fav.decoding = 'async';
    fav.referrerPolicy = 'no-referrer';
    fav.addEventListener('error', function () { fav.hidden = true; });
    const meta = el('div', 'meta');
    headTitle = el('div', 'title');
    headSub = el('div', 'sub');
    meta.append(headTitle, headSub);
    delBtn = button('btn', 'Delete notes for this page', icon(I_TRASH, 16, 1.5));
    const closeBtn = button('btn', 'Close notes (Esc)', icon(I_CLOSE, 16, 1.5));
    head.append(fav, meta, delBtn, closeBtn);

    scroller = el('div', 'body');
    doc = el('div', 'doc');

    // The rest of the site's notes: open, unless you have folded them away.
    const siteOpen = !!store.get('ui:siteOpen', true);
    siteBox = el('div', 'site');
    siteToggle = el('button', 'site-toggle');
    siteToggle.type = 'button';
    siteToggle.setAttribute('aria-expanded', String(siteOpen));
    siteLabel = el('span');
    siteToggle.append(icon(I_CHEVRON, 12, 1.5), siteLabel);
    siteList = el('ul', 'site-list');
    siteList.hidden = !siteOpen;
    siteBox.append(siteToggle, siteList);
    siteBox.hidden = true;
    scroller.append(doc, siteBox);

    toast = el('div', 'toast');
    toast.setAttribute('role', 'status');
    toastText = el('span');
    toastUndo = el('button', null, 'Undo');
    toastUndo.type = 'button';
    toast.append(toastText, toastUndo);

    menu = el('div', 'menu');
    menu.setAttribute('role', 'listbox');
    menu.setAttribute('aria-label', 'Format');
    menu.hidden = true;

    panel.append(head, scroller, menu, toast);
    root.append(pill, panel);
    shadow.appendChild(root);
    document.documentElement.appendChild(host);
    applyStyles();

    wire();
    delBtn.addEventListener('click', clearPage);
    closeBtn.addEventListener('click', function () { close(true); });
  }

  // Adopted rather than a <style> element: a strict style-src CSP can block a
  // <style> even inside a shadow root, and a constructed sheet is not inline.
  // If adoption is refused or silently ignored, the check below catches it and
  // falls back to the element.
  function applyStyles() {
    try {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(STYLE);
      shadow.adoptedStyleSheets = [sheet];
    } catch (e) {}
    if (getComputedStyle(pill).position !== 'fixed') {
      const s = document.createElement('style');
      s.textContent = STYLE;
      shadow.insertBefore(s, shadow.firstChild);
    }
  }

  function wire() {
    // Pointer events stop at the shadow root on their way back up, after the UI
    // has handled them, so the page's bubbling handlers ("click outside closes
    // the menu", analytics) never see clicks in the notes.
    ['pointerdown', 'pointerup', 'pointermove', 'mousedown', 'mouseup', 'mousemove', 'click',
     'dblclick', 'auxclick', 'contextmenu', 'wheel', 'touchstart', 'touchmove', 'touchend']
      .forEach(function (t) {
        shadow.addEventListener(t, function (e) { e.stopPropagation(); }, { passive: true });
      });

    pill.addEventListener('pointerdown', onPillDown);
    pill.addEventListener('pointermove', onPillMove);
    pill.addEventListener('pointerup', onPillUp);
    pill.addEventListener('pointercancel', onPillUp);
    pill.addEventListener('click', function () {
      if (suppressClick) { suppressClick = false; return; }
      toggle(true);
    });
    pill.addEventListener('pointerenter', function (e) {
      hovering = true;
      if (e.pointerType === 'mouse' && data && !isOpen && !drag) pill.classList.add('peeking');
    });
    pill.addEventListener('pointerleave', function () {
      hovering = false;
      if (!peekTimer) pill.classList.remove('peeking');
    });

    siteToggle.addEventListener('click', function () {
      const show = siteList.hidden;
      siteList.hidden = !show;
      siteToggle.setAttribute('aria-expanded', String(show));
      store.set('ui:siteOpen', show);
    });
    // Another page's to-dos can be ticked from here. Its text is edited on its
    // own page, which the arrow beside its title goes to.
    siteList.addEventListener('mousedown', function (e) {
      if (e.target.closest && e.target.closest('.mark')) e.preventDefault();
    });
    siteList.addEventListener('click', function (e) {
      const mark = e.target.closest && e.target.closest('.check');
      if (mark) toggleOther(mark.parentNode);
    });

    // The menu never takes focus, so the caret stays in the note being typed.
    menu.addEventListener('mousedown', function (e) { e.preventDefault(); });
    menu.addEventListener('click', function (e) {
      const item = e.target.closest && e.target.closest('.menu-item');
      if (item) pickFormat(menuItems[+item.dataset.i]);
    });
    scroller.addEventListener('scroll', hideMenu, { passive: true });
    toastUndo.addEventListener('click', function () {
      const fn = undoFn;
      hideToast();
      if (fn) fn();
    });

    doc.addEventListener('mousedown', function (e) {
      // Ticking a to-do must not steal the caret from the note being written.
      if (e.target.closest && e.target.closest('.mark')) { e.preventDefault(); return; }
      if (e.target !== doc) return;
      // A click in the empty space below the last note continues the document.
      const last = doc.lastElementChild;
      if (!last || e.clientY < last.getBoundingClientRect().bottom) return;
      e.preventDefault();
      if (last.lastChild.value || last.dataset.type !== 'p') {
        const b = makeBlock({ type: 'p', text: '' });
        doc.appendChild(b);
        fit(b.lastChild);
        place(b, 0);
      } else {
        place(last, 'end');
      }
    });
    doc.addEventListener('click', function (e) {
      const mark = e.target.closest && e.target.closest('.check');
      if (mark) toggleDone(mark.parentNode);
    });
  }

  // =====================================================================
  // The pill: position, drag, peek
  // =====================================================================

  function placePill() {
    const vh = window.innerHeight;
    const h = pill.offsetHeight || PILL;
    const y = Math.max(M, Math.min(pos.y, vh - h - M));
    pill.style.top = y + 'px';
    pill.classList.toggle('left', pos.side === 'left');
    if (pos.side === 'left') { pill.style.left = M + 'px'; pill.style.right = 'auto'; }
    else { pill.style.right = M + 'px'; pill.style.left = 'auto'; }
  }

  function onPillDown(e) {
    if (e.button !== 0) return;
    suppressClick = false;
    const r = pill.getBoundingClientRect();
    drag = { id: e.pointerId, x: e.clientX, y: e.clientY, left: r.left, top: r.top, moved: false };
    try { pill.setPointerCapture(e.pointerId); } catch (x) {}
  }

  function onPillMove(e) {
    if (!drag || e.pointerId !== drag.id) return;
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    if (!drag.moved) {
      // Four pixels of slack, so a click that wobbles is still a click.
      if (dx * dx + dy * dy < 16) return;
      drag.moved = true;
      pill.classList.add('dragging');
      pill.classList.remove('peeking');
    }
    const vw = document.documentElement.clientWidth, vh = window.innerHeight;
    const w = pill.offsetWidth, h = pill.offsetHeight;
    pill.style.left = Math.max(4, Math.min(drag.left + dx, vw - w - 4)) + 'px';
    pill.style.right = 'auto';
    pill.style.top = Math.max(4, Math.min(drag.top + dy, vh - h - 4)) + 'px';
  }

  function onPillUp(e) {
    if (!drag || e.pointerId !== drag.id) return;
    const d = drag;
    drag = null;
    try { pill.releasePointerCapture(e.pointerId); } catch (x) {}
    if (!d.moved) return;   // a plain click; the click handler takes it from here
    suppressClick = true;
    pill.classList.remove('dragging');

    // Dropped anywhere, it settles against the nearer side edge at the height
    // it was left, like a floating button on a phone. The side is saved rather
    // than a raw x, so it stays on its edge when the window is resized.
    const r = pill.getBoundingClientRect();
    pos = { side: r.left + r.width / 2 < document.documentElement.clientWidth / 2 ? 'left' : 'right', y: Math.round(r.top) };
    store.set('ui:pos', pos);

    // FLIP: anchor it to the edge, then animate from where it was dropped.
    placePill();
    const dx = r.left - pill.getBoundingClientRect().left;
    pill.style.transition = 'none';
    pill.style.transform = 'translateX(' + dx + 'px)';
    pill.getBoundingClientRect();
    pill.style.transition = 'transform .32s ' + EASE;
    pill.style.transform = '';
    setTimeout(function () { pill.style.transition = ''; }, 340);
    if (isOpen) placePanel();
  }

  // On a page that has notes, the pill opens out briefly to show the first
  // line, so coming back to a page tells you there is something here.
  function peek(ms) {
    if (!pill || !data || isOpen || pill.classList.contains('off')) return;
    pill.classList.add('peeking');
    clearTimeout(peekTimer);
    peekTimer = setTimeout(function () {
      peekTimer = 0;
      if (!hovering) pill.classList.remove('peeking');
    }, ms);
  }

  function refreshPill() {
    if (!pill) return;
    const n = data && data.blocks ? data.blocks.length : 0;
    pillCount.textContent = n ? String(n) : '';
    pillPeek.textContent = n ? firstLine(data) : '';
    pill.classList.toggle('has', n > 0);
    pill.setAttribute('aria-label', n ? 'Notes for this page, ' + n + (n === 1 ? ' note' : ' notes') : 'Notes for this page');
    pill.title = n ? '' : 'Notes for this page (Alt+N)';
    if (!n) pill.classList.remove('peeking');
  }

  function applyHidden() {
    if (pill) pill.classList.toggle('off', !!store.get(HIDE_KEY, false));
  }

  // =====================================================================
  // The panel
  // =====================================================================

  // Opens below the pill, aligned to the same edge, or above it when the pill
  // has been dragged low. It is never taller than the room it has.
  function placePanel() {
    const r = pill.getBoundingClientRect();
    const vw = document.documentElement.clientWidth, vh = window.innerHeight;
    panel.style.width = Math.min(340, vw - 2 * M) + 'px';
    const below = vh - r.bottom - GAP - M, above = r.top - GAP - M;
    const down = below >= 320 || below >= above;
    panel.style.maxHeight = Math.max(160, Math.min(560, down ? below : above)) + 'px';
    if (down) { panel.style.top = (r.bottom + GAP) + 'px'; panel.style.bottom = 'auto'; }
    else { panel.style.bottom = (vh - r.top + GAP) + 'px'; panel.style.top = 'auto'; }
    if (pos.side === 'left') { panel.style.left = M + 'px'; panel.style.right = 'auto'; }
    else { panel.style.right = M + 'px'; panel.style.left = 'auto'; }
    panel.style.transformOrigin = (down ? 'top ' : 'bottom ') + pos.side;
  }

  function open(focus) {
    if (!host) return;
    if (!isOpen) {
      isOpen = true;
      store.set('ui:open', true);
      clearTimeout(peekTimer);
      peekTimer = 0;
      pill.classList.remove('peeking');
      pill.classList.add('open');
      pill.setAttribute('aria-expanded', 'true');
      refreshHead();
      renderSite();
      placePanel();
      panel.classList.add('open');
      fitAll();
    }
    if (focus) {
      // Remember what had focus on the page, to hand it back on Escape.
      const active = document.activeElement;
      if (active && active !== host && active !== document.body) returnFocus = active;
      place(doc.lastElementChild, 'end');
    }
  }

  function close(restoreFocus) {
    if (!isOpen) return;
    flush();
    isOpen = false;
    store.set('ui:open', false);
    panel.classList.remove('open');
    pill.classList.remove('open');
    pill.setAttribute('aria-expanded', 'false');
    hideToast();
    hideMenu();
    const inside = shadow.activeElement;
    if (restoreFocus) {
      const target = returnFocus && returnFocus.isConnected ? returnFocus : pill;
      try { target.focus({ preventScroll: true }); } catch (e) {}
    } else if (inside && inside !== pill) {
      inside.blur();
    }
    returnFocus = null;
  }

  // Closing hands focus back only if it was inside the notes. Closed with
  // Alt+N while reading the page, the page keeps its focus.
  function toggle(focus) {
    if (isOpen) close(!!shadow.activeElement);
    else open(focus);
  }

  function refreshHead() {
    if (!headTitle) return;
    const site = location.hostname.replace(/^www\./, '');
    headTitle.textContent = cleanTitle(document.title) || site || 'This page';
    headSub.textContent = data && data.updated ? site + ' · Edited ' + ago(data.updated) : site;
    delBtn.hidden = !data;
    const src = favicon();
    if (src && fav.getAttribute('src') !== src) { fav.hidden = false; fav.src = src; }
    else if (!src) fav.hidden = true;
  }

  function favicon() {
    try {
      const l = document.querySelector('link[rel~="icon" i]');
      return l && l.href ? l.href : location.origin + '/favicon.ico';
    } catch (e) { return ''; }
  }

  // Notes from the other pages on this site, newest first, shown in full
  // below this page's own. Reading them does not leave the page you are on:
  // the arrow beside each title is the only thing here that navigates.
  function renderSite() {
    const mine = siteKey(key);
    const items = [];
    store.keys().forEach(function (k) {
      if (k.indexOf(NOTE) !== 0 || k === key || siteKey(k) !== mine) return;
      const v = store.get(k, null);
      if (v && v.blocks && v.blocks.length && /^https?:/i.test(v.url || '')) items.push({ k: k, v: v });
    });
    siteList.textContent = '';
    siteBox.hidden = !items.length;
    if (!items.length) return;
    items.sort(function (a, b) { return (b.v.updated || 0) - (a.v.updated || 0); });
    siteLabel.textContent = items.length + (items.length === 1 ? ' other page' : ' other pages') +
      ' on ' + (location.hostname.replace(/^www\./, '') || mine);
    items.slice(0, 50).forEach(function (it) { siteList.appendChild(group(it.k, it.v)); });
  }

  function group(k, v) {
    const li = el('li', 'group');
    li.dataset.key = k;
    const name = cleanTitle(v.title) || v.url;
    const top = el('div', 'group-head');
    const title = el('div', 'group-title', name);
    title.title = v.url;
    const go = el('a', 'go');
    go.href = v.url;
    go.title = 'Go to this page' + (v.updated ? ' · edited ' + ago(v.updated) : '');
    go.setAttribute('aria-label', 'Go to ' + name);
    go.appendChild(icon(I_GO, 16, 1.5));
    top.append(title, go);
    li.appendChild(top);
    v.blocks.forEach(function (b, i) {
      const type = TYPES.indexOf(b.type) !== -1 ? b.type : 'p';
      const done = type === 'todo' && !!b.done;
      const row = el('div', 'block ro');
      row.dataset.type = type;
      row.dataset.done = done ? '1' : '0';
      row.dataset.i = String(i);
      const mark = el('span', 'mark');
      markFor(mark, type, done);
      row.append(mark, el('div', 'text', type === 'hr' ? '' : String(b.text)));
      li.appendChild(row);
    });
    renumber(li);
    return li;
  }

  // Saved straight to the other page's entry; that page shows it next time,
  // or at once if it is open in another tab.
  function toggleOther(row) {
    const k = row.parentNode.dataset.key;
    const v = store.get(k, null);
    const b = v && v.blocks && v.blocks[+row.dataset.i];
    if (!b || b.type !== 'todo') return;
    if (b.done) delete b.done;
    else b.done = true;
    v.updated = Date.now();
    store.set(k, v);
    row.dataset.done = b.done ? '1' : '0';
    row.firstChild.setAttribute('aria-checked', String(!!b.done));
  }

  function showToast(text, undo) {
    toastText.textContent = text;
    undoFn = undo;
    toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(hideToast, 5000);
  }

  function hideToast() {
    clearTimeout(toastTimer);
    undoFn = null;
    if (toast) toast.classList.remove('show');
  }

  // Deleting asks nothing; it offers Undo instead. A confirmation costs a click
  // every time, an undo only on the rare occasion it is wanted.
  function clearPage() {
    flush();
    if (!data) return;
    const saved = data, k = key;
    store.del(k);
    data = null;
    render();
    refreshPill();
    refreshHead();
    place(doc.firstElementChild, 0);
    showToast('Notes deleted', function () {
      store.set(k, saved);
      if (k !== key) return;
      data = saved;
      render();
      refreshPill();
      refreshHead();
    });
  }

  // =====================================================================
  // The editor
  // =====================================================================

  // One textarea per block, Notion-style: Enter starts the next block, and
  // Backspace at the start of one joins it to the block above. Plain
  // textareas rather than contenteditable, so what is pasted in stays plain
  // text and the caret behaves the way the browser's own fields do.

  const FIELD_SIZING = (function () {
    try { return CSS.supports('field-sizing', 'content'); } catch (e) { return false; }
  })();

  function fit(ta) {
    if (FIELD_SIZING) return;
    ta.style.height = 'auto';
    ta.style.height = ta.scrollHeight + 'px';
  }

  function fitAll() {
    if (!FIELD_SIZING && doc) doc.querySelectorAll('textarea').forEach(fit);
  }

  function makeBlock(b) {
    const block = el('div', 'block');
    const mark = el('span', 'mark');
    const ta = el('textarea');
    ta.rows = 1;
    ta.dir = 'auto';   // Urdu or Arabic in a note reads right to left, on its own
    ta.setAttribute('aria-label', 'Note');
    ta.value = b && typeof b.text === 'string' ? b.text : '';
    block.append(mark, ta);
    setType(block, b && TYPES.indexOf(b.type) !== -1 ? b.type : 'p', !!(b && b.done));
    return block;
  }

  function setType(block, type, done) {
    block.dataset.type = type;
    block.dataset.done = type === 'todo' && done ? '1' : '0';
    markFor(block.firstChild, type, block.dataset.done === '1');
    block.lastChild.placeholder = PLACEHOLDER[type];
    updateLead();
  }

  // The bullet or checkbox beside a block, shared by the editor and by the
  // notes shown from the rest of the site.
  function markFor(mark, type, done) {
    mark.textContent = '';
    mark.className = 'mark';
    ['role', 'aria-checked', 'aria-label'].forEach(function (a) { mark.removeAttribute(a); });
    if (type === 'ol') { mark.className = 'mark num'; return; }   // numbered by renumber()
    if (type !== 'todo') return;
    mark.className = 'mark check';
    mark.setAttribute('role', 'checkbox');
    mark.setAttribute('aria-checked', String(done));
    mark.setAttribute('aria-label', 'Done');
    const box = el('span', 'box');
    box.appendChild(icon(I_CHECK, 10, 2.4));
    mark.appendChild(box);
  }

  function toggleDone(block) {
    const done = block.dataset.done !== '1';
    block.dataset.done = done ? '1' : '0';
    block.firstChild.setAttribute('aria-checked', String(done));
    changed(true);
  }

  // The invitation to write shows only while the page has no notes at all;
  // after that, an empty block shows its hint only while it has the caret.
  function updateLead() {
    if (!doc) return;
    const first = doc.firstElementChild;
    const empty = !!first && first === doc.lastElementChild && first.dataset.type === 'p' && !first.lastChild.value;
    doc.classList.toggle('empty', empty);
    if (first && first.dataset.type === 'p') first.lastChild.placeholder = empty ? LEAD : PLACEHOLDER.p;
  }

  function render() {
    if (!doc) return;
    hideMenu();
    doc.textContent = '';
    const blocks = data && data.blocks && data.blocks.length ? data.blocks : [{ type: 'p', text: '' }];
    blocks.forEach(function (b) { doc.appendChild(makeBlock(b)); });
    renumber(doc);
    updateLead();
    fitAll();
    dirty = false;
  }

  // A numbered list counts its own run of items and starts again after
  // anything else.
  function renumber(container) {
    let n = 0;
    Array.prototype.forEach.call(container.children, function (b) {
      if (!b.classList.contains('block')) return;
      if (b.dataset.type === 'ol') b.firstChild.textContent = ++n + '.';
      else n = 0;
    });
  }

  function serialize() {
    const out = [];
    doc.querySelectorAll('.block').forEach(function (block) {
      const text = block.dataset.type === 'hr' ? '' : block.lastChild.value;
      if (!text.trim() && block.dataset.type !== 'hr') return;
      const b = { type: block.dataset.type, text: text };
      if (b.type === 'todo' && block.dataset.done === '1') b.done = true;
      out.push(b);
    });
    return out;
  }

  // Put the caret in a block, and keep that block in view inside the panel.
  // Scrolled by hand: scrollIntoView could also scroll the page underneath.
  function place(block, at) {
    if (!block) return;
    hideMenu();
    const ta = block.lastChild;
    try { ta.focus({ preventScroll: true }); } catch (e) { ta.focus(); }
    const p = at === 'end' ? ta.value.length : at;
    try { ta.setSelectionRange(p, p); } catch (e) {}
    const b = block.getBoundingClientRect(), view = scroller.getBoundingClientRect();
    if (b.top < view.top) scroller.scrollTop -= view.top - b.top + 8;
    else if (b.bottom > view.bottom) scroller.scrollTop += b.bottom - view.bottom + 8;
  }

  // Markdown as you type, the way Notion does it: "[] " starts a to-do,
  // "- " a list, "# " a heading, and so on. Only at the moment it is typed,
  // with the caret right after the marker, so a pasted note that happens to
  // begin with "- " is left as written.
  const SHORTCUTS = [
    [/^\[(?: ?|x)\] /i, 'todo'], [/^[-*•] /, 'ul'], [/^\d+[.)] /, 'ol'], [/^#{2,3} /, 'h2'],
    [/^# /, 'h'], [/^> /, 'quote'], [/^! /, 'callout'], [/^```/, 'code'], [/^---$/, 'hr']
  ];

  function markdown(block, ta) {
    const v = ta.value;
    for (let i = 0; i < SHORTCUTS.length; i++) {
      const m = SHORTCUTS[i][0].exec(v);
      if (!m || ta.selectionStart !== m[0].length) continue;
      ta.value = v.slice(m[0].length);
      toType(block, SHORTCUTS[i][1], /x/i.test(m[0]));
      return true;
    }
    return false;
  }

  // Turn a block into another kind. A divider holds no text, so the caret
  // moves on to a fresh block after it.
  function toType(block, type, done) {
    const ta = block.lastChild;
    setType(block, type, done);
    renumber(doc);
    if (type === 'hr') {
      ta.value = '';
      const next = makeBlock({ type: 'p', text: '' });
      block.after(next);
      fit(next.lastChild);
      place(next, 0);
      return;
    }
    fit(ta);
    try { ta.setSelectionRange(0, 0); } catch (e) {}
  }

  // ---------- the "/" menu ----------

  // Typing "/" at the start of a block opens the menu; what follows filters
  // it ("/num" leaves Numbered list). Arrows move, Enter picks, Esc closes.
  function updateMenu(block, ta) {
    const v = ta.value, s = ta.selectionStart;
    if (block.dataset.type === 'code' || v[0] !== '/' || s < 1 || s !== ta.selectionEnd || v.slice(0, s).indexOf('\n') !== -1) {
      hideMenu();
      return;
    }
    const q = v.slice(1, s).trim().toLowerCase();
    menuItems = FORMATS.filter(function (f) { return !q || f.label.toLowerCase().indexOf(q) !== -1; });
    if (!menuItems.length || q.length > 24) { hideMenu(); return; }
    if (q !== menuQuery || menuBlock !== block) menuIndex = 0;
    menuQuery = q;
    menuBlock = block;
    paintMenu();
    menu.hidden = false;
    // Just below the block, or above it when the panel runs out of room.
    const p = panel.getBoundingClientRect(), b = block.getBoundingClientRect();
    const h = menu.offsetHeight;
    const below = b.bottom - p.top + 4;
    menu.style.top = (below + h <= p.height - 8 ? below : Math.max(8, b.top - p.top - h - 4)) + 'px';
  }

  function paintMenu() {
    menu.textContent = '';
    menuItems.forEach(function (f, i) {
      const item = el('div', 'menu-item');
      item.dataset.i = String(i);
      item.setAttribute('role', 'option');
      item.setAttribute('aria-selected', String(i === menuIndex));
      item.append(el('span', null, f.label), el('span', 'menu-hint', f.hint));
      menu.appendChild(item);
    });
    const on = menu.children[menuIndex];
    if (on) {
      if (on.offsetTop < menu.scrollTop) menu.scrollTop = on.offsetTop - 4;
      else if (on.offsetTop + on.offsetHeight > menu.scrollTop + menu.clientHeight) menu.scrollTop = on.offsetTop + on.offsetHeight - menu.clientHeight + 4;
    }
  }

  function hideMenu() {
    if (menu) menu.hidden = true;
    menuBlock = null;
    menuQuery = '';
  }

  const menuOpen = function () { return !!menu && !menu.hidden && !!menuBlock; };

  function pickFormat(f) {
    const block = menuBlock;
    if (!block || !f) return;
    const ta = block.lastChild;
    ta.value = ta.value.slice(ta.selectionStart);   // drop the "/query" that was typed
    hideMenu();
    toType(block, f.type, false);
    if (f.type !== 'hr') place(block, 0);
    changed(true);
  }

  // What Enter starts next: lists carry on as lists (1 = continue), and an
  // empty quote or highlight turns back into text (0) rather than repeating.
  const CONTINUES = { todo: 1, ul: 1, ol: 1, quote: 0, callout: 0 };

  function blockKey(e, ta) {
    const block = ta.parentNode;
    const type = block.dataset.type;
    const v = ta.value, s = ta.selectionStart, end = ta.selectionEnd;
    const collapsed = s === end;
    const mod = e.ctrlKey || e.metaKey;

    if (e.key === 'Enter') {
      // Ctrl/Cmd+Enter ticks a to-do, or turns the block into one.
      if (mod && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        if (type === 'todo') toggleDone(block);
        else { setType(block, 'todo', false); changed(true); }
        return;
      }
      if (e.shiftKey || e.altKey || mod) return;   // Shift+Enter: a line break inside the block
      // In code, Enter is a new line; Enter on an empty last line leaves the block.
      if (type === 'code') {
        if (!(collapsed && s === v.length && v.slice(-1) === '\n')) return;
        e.preventDefault();
        ta.value = v.slice(0, -1);
        fit(ta);
        const after = makeBlock({ type: 'p', text: '' });
        block.after(after);
        fit(after.lastChild);
        place(after, 0);
        changed(true);
        return;
      }
      e.preventDefault();
      // Enter on an empty list item ends the list, as in every editor.
      if (!v && CONTINUES[type] !== undefined && type !== 'p') { setType(block, 'p'); changed(true); return; }
      ta.value = v.slice(0, s);
      fit(ta);
      const next = makeBlock({ type: CONTINUES[type] ? type : 'p', text: v.slice(end) });
      block.after(next);
      fit(next.lastChild);
      place(next, 0);
      changed(true);
      return;
    }

    if (e.key === 'Backspace' && collapsed && s === 0 && !mod && !e.altKey) {
      // First press turns a to-do, bullet or heading back into plain text;
      // the next joins it to the block above.
      if (type !== 'p') { e.preventDefault(); setType(block, 'p'); changed(true); return; }
      const prev = block.previousElementSibling;
      if (!prev) return;
      e.preventDefault();
      const pta = prev.lastChild, at = pta.value.length;
      pta.value += v;
      fit(pta);
      block.remove();
      place(prev, at);
      changed(true);
      return;
    }

    if (e.key === 'Delete' && collapsed && s === v.length && !mod && !e.altKey) {
      const next = block.nextElementSibling;
      if (!next) return;
      e.preventDefault();
      ta.value = v + next.lastChild.value;
      fit(ta);
      next.remove();
      ta.setSelectionRange(s, s);
      changed(true);
      return;
    }

    if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && collapsed && !e.shiftKey && !mod && !e.altKey) {
      const up = e.key === 'ArrowUp';
      const sib = up ? block.previousElementSibling : block.nextElementSibling;
      if (!sib) return;
      if (up ? s === 0 : s === v.length) { e.preventDefault(); place(sib, up ? 'end' : 0); return; }
      // Mid-block, let the browser move the caret first. If that carried it to
      // the very edge from the first (or last) line, the next press would have
      // done nothing, so step into the neighbouring block now instead.
      const edgeLine = up ? v.lastIndexOf('\n', s - 1) === -1 : v.indexOf('\n', s) === -1;
      if (!edgeLine) return;
      setTimeout(function () {
        if (shadow.activeElement !== ta) return;
        const now = ta.selectionStart;
        if (up ? now === 0 : now === ta.value.length) place(sib, up ? 'end' : 0);
      }, 0);
    }
  }

  // =====================================================================
  // Saving
  // =====================================================================

  // Saved as you type, a moment after you pause, and at once when the
  // structure changes. Empty blocks are not stored; a page whose notes are
  // all deleted has its entry removed rather than kept as an empty shell.
  function changed(now) {
    dirty = true;
    renumber(doc);
    updateLead();
    clearTimeout(saveTimer);
    if (now) flush();
    else saveTimer = setTimeout(flush, 400);
  }

  // `leaving` is set when the URL has already moved on (an in-page navigation),
  // so the title on screen may belong to the next page and is not taken.
  function flush(leaving) {
    clearTimeout(saveTimer);
    saveTimer = 0;
    if (!dirty || !doc) return;
    dirty = false;
    const blocks = serialize();
    if (!blocks.length) {
      if (data) { store.del(key); data = null; }
    } else {
      const now = Date.now();
      const title = leaving ? '' : cleanTitle(document.title);
      data = {
        url: pageHref,
        title: title || (data && data.title) || '',
        blocks: blocks,
        created: (data && data.created) || now,
        updated: now
      };
      store.set(key, data);
    }
    refreshPill();
    refreshHead();
  }

  // Another tab saved this page's notes: take them, unless you are typing here,
  // in which case this tab's copy wins and is saved over theirs.
  function watchKey() {
    unwatch();
    unwatch = store.watch(key, function (v) {
      if (isOpen && shadow && shadow.activeElement && shadow.activeElement.tagName === 'TEXTAREA') return;
      data = v || null;
      render();
      refreshPill();
      refreshHead();
    });
  }

  // =====================================================================
  // Following the page
  // =====================================================================

  // Single-page apps change the URL without reloading, and each URL is a page
  // with its own notes. Checked on history events and once a second, which is
  // cheap: a string comparison.
  function onUrl() {
    const href = location.href;
    if (href === pageHref) return;
    const next = keyFor(href);
    if (next === key) { pageHref = href; return; }   // only the fragment or a tracking parameter changed
    flush(true);
    pageHref = href;
    key = next;
    data = store.get(key, null);
    watchKey();
    hideToast();
    render();
    refreshPill();
    refreshHead();
    if (isOpen) renderSite();
    else peek(3500);
  }

  function tick() {
    onUrl();
    if (isOpen) refreshHead();
    // Some sites rebuild <html>'s children wholesale; if the host was thrown
    // out with them, put it back.
    if (host && !host.isConnected && document.documentElement) document.documentElement.appendChild(host);
  }

  // =====================================================================
  // Keys
  // =====================================================================

  // See the header note. Every listener below is on window, in the capture
  // phase, so it runs before anything the page attached to document or body.
  function isEditable(t) {
    if (!t || t.nodeType !== 1) return false;
    if (t.isContentEditable) return true;
    const tag = t.tagName;
    if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
    return tag === 'INPUT' && !/^(button|checkbox|radio|range|color|file|image|reset|submit)$/i.test(t.type);
  }

  const isToggleKey = function (e) {
    return e.code === 'KeyN' && e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && !e.repeat;
  };

  // Alt+N anywhere on the page, but never while you are typing into one of the
  // page's own fields: that keystroke belongs to the page.
  function shortcut(e) {
    if (!host || !isToggleKey(e)) return;
    const t = (e.composedPath && e.composedPath()[0]) || e.target;
    if (isEditable(t)) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    toggle(true);
  }

  function onKey(e) {
    if (e.isComposing || e.keyCode === 229) return;   // an IME is mid-word; its Enter picks a candidate
    if (menuOpen()) {
      if (e.key === 'Escape') { e.preventDefault(); hideMenu(); return; }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        menuIndex = (menuIndex + (e.key === 'ArrowDown' ? 1 : -1) + menuItems.length) % menuItems.length;
        paintMenu();
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); pickFormat(menuItems[menuIndex]); return; }
    }
    if (e.key === 'Escape') { e.preventDefault(); close(true); return; }
    if (isToggleKey(e)) { e.preventDefault(); toggle(true); return; }
    const t = shadow.activeElement;
    if (t && t.tagName === 'TEXTAREA') blockKey(e, t);
  }

  function onInput() {
    const t = shadow.activeElement;
    if (!t || t.tagName !== 'TEXTAREA') return;
    const block = t.parentNode;
    if (block.dataset.type === 'hr' && t.value) setType(block, 'p');   // typing on a divider makes it text
    if (block.dataset.type === 'p') markdown(block, t);
    if (shadow.activeElement === t) updateMenu(block, t);
    fit(t);
    changed();
  }

  ['keydown', 'keyup', 'keypress', 'beforeinput', 'input', 'textInput', 'paste', 'copy', 'cut',
   'compositionstart', 'compositionupdate', 'compositionend', 'focusin', 'focusout',
   'selectstart', 'dragstart', 'dragenter', 'dragover', 'dragleave', 'drop', 'dragend']
    .forEach(function (type) {
      window.addEventListener(type, function (e) {
        if (!host || e.target !== host) {
          if (type === 'keydown') shortcut(e);
          return;
        }
        if (type === 'keydown') onKey(e);
        else if (type === 'input') onInput();
        e.stopImmediatePropagation();
      }, true);
    });

  // =====================================================================
  // Start
  // =====================================================================

  if (typeof GM_registerMenuCommand === 'function') {
    try {
      GM_registerMenuCommand('Show or hide the notes pill on this site', function () {
        store.set(HIDE_KEY, !store.get(HIDE_KEY, false));
        applyHidden();
      });
      GM_registerMenuCommand('Move the notes pill back to the top-right corner', function () {
        pos = normPos(null);
        store.set('ui:pos', pos);
        if (!pill) return;
        placePill();
        if (isOpen) placePanel();
      });
    } catch (e) {}
  }

  function start() {
    // Only on an HTML page, and only once: a loader and a full install
    // running side by side would otherwise stack two pills.
    if (!(document.documentElement instanceof HTMLElement)) return;
    if (document.querySelector('page-notes-root')) return;

    build();
    render();
    refreshPill();
    applyHidden();
    placePill();
    watchKey();
    // It opens the way you left it. Restored without taking focus, so it never
    // steals the caret from a page that puts it in its own search box.
    if (store.get('ui:open', false)) open(false);
    else peek(3500);

    window.addEventListener('resize', function () {
      placePill();
      if (isOpen) placePanel();
    });
    window.addEventListener('popstate', onUrl);
    window.addEventListener('hashchange', onUrl);
    try { if (window.navigation) window.navigation.addEventListener('navigatesuccess', onUrl); } catch (e) {}
    window.addEventListener('pagehide', function () { flush(); });
    document.addEventListener('visibilitychange', function () { if (document.hidden) flush(); });
    setInterval(tick, 1000);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();

  // =====================================================================
  // Small things
  // =====================================================================

  // "(2) Feed | LinkedIn": the number is the site's unread badge, not part of
  // the page's name.
  function cleanTitle(t) {
    return String(t || '').replace(/^\(\d+\+?\)\s*/, '').trim();
  }

  function firstLine(d) {
    const b = d && d.blocks && d.blocks[0];
    return b ? String(b.text).split('\n')[0].trim() : '';
  }

  function ago(ts) {
    const s = (Date.now() - ts) / 1000;
    if (s < 45) return 'just now';
    if (s < 3600) return Math.round(s / 60) + 'm ago';
    if (s < 86400) return Math.round(s / 3600) + 'h ago';
    if (s < 172800) return 'yesterday';
    return new Date(ts).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  }
})();
