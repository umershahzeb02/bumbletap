// ==UserScript==
// @name         Audio Float Player
// @version      3.0.0
// @description  Finds the audio on any page and sends it to one player queue that follows you across sites.
// @match        *://*/*
// @run-at       document-idle
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @connect      *
// @require      https://umershahzeb02.github.io/bumbletap/scripts/audio-player/id3.js?v=1
// ==/UserScript==

/* NOTE ON @grant — this matters, don't revert it casually.
   With "@grant none" the script runs directly in page context. The moment any
   @grant is declared, Tampermonkey moves it into a sandbox where `window` is a
   PROXY, not the page's real window. The four interceptors below patch page
   globals (HTMLMediaElement.prototype, Audio, fetch, XHR) — patching the
   sandbox's copies would silently detect nothing at all. Everything that must
   touch the page therefore goes through W (= unsafeWindow) below.

   Bump the ?v= on the @require whenever id3.js changes — Tampermonkey caches
   required files aggressively and will otherwise keep serving the old copy.

   Three ways this file runs:
     BumbleTap     custom code bound to a key (V), in BumbleTap's USER_SCRIPT
                   world. http() and binding are passed in as arguments. Every
                   press of V runs the file again in the same world.
     Tampermonkey  once per page, at document-idle.
     Extension     registered twice: AFP_ROLE='intercept' in MAIN, full in
                   ISOLATED (see EXTENSION-SETUP.md).

   The UI lives in an open shadow root on ONE host element,
   <bt-audio id="bt-audio-host">. Nothing else is added to the page: no ids, no
   classes, no <style> in the head. Open, so BumbleTap's typing check can see
   inside it. */

(() => {
  // The page's real window. Falls back to `window` if unsafeWindow is denied,
  // which keeps the UI working even if interception degrades.
  const W = (typeof unsafeWindow !== 'undefined' && unsafeWindow) ? unsafeWindow : window;

  /* Version banner — deliberately loud. This script is PASTED into the
     extension, not served, so pushing a fix does not update the running copy.
     If the console does not show this line with the current version, the
     extension is running a stale paste. */
  const AFP_VERSION = '3.0.0';
  const HOST_ID = 'bt-audio-host';
  const AUDIO_EXTS = ['mp3','wav','ogg','oga','flac','aac','m4a','opus','wma','webm'];

  /* ===== ROLE =====
     One file, two jobs, because the two halves must live in different worlds:

       'intercept'  MAIN world. Installs the four page-global patches and
                    postMessages what it finds. No UI, no player state.
       'full'       (default) The player: UI, queue, ID3, popup handoff.

     Registering one copy in each world without this switch would build two UIs. */
  const ROLE = (typeof AFP_ROLE !== 'undefined' && AFP_ROLE) ? String(AFP_ROLE) : 'full';

  if (ROLE === 'intercept') {
    // Minimal path. Nothing below this point is defined or needed.
    const seen = new Set();
    installInterceptors((url, source, el, trusted) => {
      try {
        if (!url || typeof url !== 'string') return;
        const abs = new URL(url, location.href).href;
        if (!/^https?:/i.test(abs)) return;
        if (!trusted && !looksLikeAudio(abs)) return;
        if (seen.has(abs)) return;              // pages re-request the same file constantly
        seen.add(abs);
        window.postMessage({ __afpFound: 1, url: abs, source: source || 'STREAM' }, '*');
      } catch (_) {}
    });
    try { console.info('[AFP] audio-float-player v' + AFP_VERSION + ' — role: intercept'); } catch (_) {}
    return;
  }

  /* ===== BUMBLETAP? =====
     BumbleTap runs custom code in its USER_SCRIPT world (not MAIN) and passes
     http() and binding in as arguments. Running from a key press also means
     the user asked for the panel, so it opens straight away. */
  const IN_BUMBLETAP = typeof http === 'function' && typeof binding === 'object' && binding !== null;

  /* ===== ONE INSTANCE =====
     Pressing V again runs this whole file again in the same world. That used
     to build a second pill, a second panel, a second set of listeners and a
     second <style>. Now the live instance is kept on globalThis and a re-run
     just toggles its panel. */
  {
    const prev = globalThis.__btAudio;
    if (prev && prev.version === AFP_VERSION && typeof prev.toggle === 'function') {
      try { prev.toggle(); } catch (_) {}
      return;
    }
    // A different version (an edited paste re-run in the same tab): replace it.
    if (prev && typeof prev.destroy === 'function') { try { prev.destroy(); } catch (_) {} }
    // A host built by a copy in another world (say, Tampermonkey and BumbleTap
    // both installed). Ask it to toggle; it cancels the event when it is alive.
    const other = document.getElementById(HOST_ID);
    if (other) {
      let handled = false;
      try { handled = !other.dispatchEvent(new CustomEvent('bt-audio:toggle', { cancelable: true })); } catch (_) {}
      if (handled) return;
      try { other.remove(); } catch (_) {}       // orphaned: its script is gone
    }
  }

  /* Are we actually in the page's world? An injected inline <script> always
     executes in MAIN, so if we can see the global it sets, we're in MAIN too.
     This decides whether the four prototype patches are worth installing.

     Skipped inside BumbleTap: its world is USER_SCRIPT, never MAIN, and on a
     strict-CSP site the inline <script> logs a CSP violation for nothing. */
  const IN_MAIN_WORLD = IN_BUMBLETAP ? false : (() => {
    try {
      const key = '__afp_w' + Math.random().toString(36).slice(2);
      const s = document.createElement('script');
      s.textContent = 'window.' + key + '=1';
      (document.documentElement || document.head).appendChild(s);
      s.remove();
      const ok = W[key] === 1;
      try { delete W[key]; } catch (_) {}
      return ok;
    } catch (_) { return false; }
  })();

  try {
    console.info('[AFP] audio-float-player v' + AFP_VERSION + ' — role: ' + ROLE
      + (IN_MAIN_WORLD ? ' (MAIN world)' : IN_BUMBLETAP ? ' (BumbleTap user-script world)' : ' (isolated/user-script world)'));
  } catch (_) {}

  const SCAN_INTERVAL = 3000;
  const POPUP_W = 380;
  const POPUP_H = 560;
  const TOAST_MS = 3200;

  /* ===== HOSTED PLAYER =====
     Opened as a URL, so every player window lands on this one fixed origin no
     matter which site opened it. That is what lets windows opened from
     different hostnames share a queue and see each other on a
     BroadcastChannel. */
  const PLAYER_URL = 'https://umershahzeb02.github.io/bumbletap/scripts/audio-player/player.html';

  /* ===== LIFETIME =====
     Everything this instance hooks is registered through these, so destroy()
     can take it all down when a newer version replaces it. */
  const ac = new AbortController();
  function on(target, type, fn, opts) {
    const o = typeof opts === 'boolean' ? { capture: opts } : Object.assign({}, opts || {});
    o.signal = ac.signal;
    try { target.addEventListener(type, fn, o); } catch (_) {}
  }
  const timers = new Set();
  function later(fn, ms) {
    const id = setTimeout(() => { timers.delete(id); try { fn(); } catch (_) {} }, ms);
    timers.add(id);
    return id;
  }
  function cancel(id) { if (id) { clearTimeout(id); timers.delete(id); } }
  const observers = [];
  let scanTimer = null;

  const sources = [];               // { url, title, kind, site }
  const sourceUrls = new Set();
  const inQueue = new Set();        // URLs the player confirmed are in its queue
  const sentUrls = new Set();       // URLs sent this session (retitle targets)
  let looking = true;               // the first scans have not finished yet

  // ===== ICONS (inline stroke SVG, currentColor) =====
  const svg = (d, w) => '<svg viewBox="0 0 24 24" width="' + (w || 16) + '" height="' + (w || 16) + '" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">' + d + '</svg>';
  const I = {
    note:  svg('<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>'),
    chev:  svg('<path d="m6 15 6-6 6 6"/>', 14),
    plus:  svg('<path d="M12 5v14M5 12h14"/>'),
    check: svg('<path d="M20 6 9 17l-5-5"/>'),
    all:   svg('<path d="M3 6h13M3 12h13M3 18h8M18 15v6M15 18h6"/>'),
    open:  svg('<path d="M14 4h6v6"/><path d="m10 14 10-10"/><path d="M19 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h4"/>'),
    x:     svg('<path d="M18 6 6 18M6 6l12 12"/>'),
    warn:  svg('<path d="M12 9v4M12 17h.01"/><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/>'),
  };

  const esc = s => String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  const extOf = url => { const m = String(url || '').split('#')[0].split('?')[0].match(/\.([a-z0-9]{2,5})$/i); return m && AUDIO_EXTS.includes(m[1].toLowerCase()) ? m[1].toLowerCase() : null; };
  const isAudioUrl = url => !!extOf(url);
  const kindOf = url => { const e = extOf(url); return e ? e.toUpperCase() : 'Audio'; };

  // ===== TRACK COLOUR =====
  // One of the site's seven tones per track, by a stable hash of its URL
  // (FNV-1a, 32-bit, over the whole URL; index = hash % 7 in this order).
  const TONES = ['#F07A2B', '#E5484D', '#2FA86A', '#3D7BF0', '#8B5CF6', '#E64C9A', '#E8B425'];
  function hashStr(s) {
    let h = 0x811c9dc5;
    s = String(s || '');
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
    return h >>> 0;
  }
  const toneOf = url => TONES[hashStr(url) % TONES.length];
  const onTone = tone => tone === '#E8B425' ? '#1A1405' : '#fff';
  // Skip series prefixes ("Ep. 12:", "Lecture 1:", "#4 –") so a series doesn't all read "E".
  const SERIES_PREFIX = /^\s*(?:(?:ep(?:isode)?|e|ch(?:apter)?|part|pt|lecture|lesson|track|no|vol(?:ume)?|session|season|s)\.?\s*#?\d+[a-z]?|#\d+)\s*[:.\-–—|)]*\s*/i;
  function firstLetter(t) {
    const s = String(t || ''), rest = s.replace(SERIES_PREFIX, '');
    const m = (rest || s).match(/[\p{L}\p{N}]/u);
    return m ? m[0].toUpperCase() : '♪';
  }
  // Generated cover: the tone gradient is CSS on the tile; this draws the
  // pattern (rings or bars, from the hash) and the first letter on top.
  function artSvg(url, title) {
    const h = hashStr(url);
    let pat = '';
    if (h & 1) {
      const c = [[0, 0], [40, 0], [0, 40], [40, 40]][(h >>> 1) & 3];
      for (let r = 9; r <= 57; r += 8) pat += '<circle cx="' + c[0] + '" cy="' + c[1] + '" r="' + r + '" fill="none" stroke="#fff" stroke-opacity=".16" stroke-width="1.6"/>';
    } else {
      for (let i = 0; i < 7; i++) {
        const bh = 7 + ((h >>> (i * 3 + 1)) & 7) * 3.2;
        pat += '<rect x="' + (3.5 + i * 5) + '" y="' + (40 - bh).toFixed(1) + '" width="3" height="' + bh.toFixed(1) + '" rx="1.5" fill="#fff" fill-opacity=".15"/>';
      }
    }
    return '<svg viewBox="0 0 40 40" aria-hidden="true" focusable="false">' + pat
      + '<text x="20" y="21" text-anchor="middle" dominant-baseline="central" fill="#fff" fill-opacity=".7" font-family="ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif" font-size="17" font-weight="700">'
      + esc(firstLetter(title)) + '</text></svg>';
  }

  // ===== SMART TITLE EXTRACTION =====
  function cleanFilename(url) {
    let name;
    try { name = decodeURIComponent(String(url).split('/').pop().split('?')[0].split('#')[0]); }
    catch (_) { name = String(url).split('/').pop().split('?')[0].split('#')[0]; }
    name = name.replace(/\.\w{2,4}$/, '');               // extension
    name = name.replace(/[-_+.]/g, ' ');                  // separators
    name = name.replace(/\b[a-f0-9]{24,}\b/gi, '');       // hex hashes
    name = name.replace(/^\d+\s*/, '').replace(/\s*\d+$/, '');
    name = name.replace(/\s+/g, ' ').trim();
    if (name && name === name.toLowerCase()) name = name.replace(/\b\w/g, c => c.toUpperCase());
    return name && name.length > 2 ? name : null;
  }

  // The page the audio was grabbed FROM — not the host serving the file. Those
  // routinely differ: a clip found on bbc.co.uk may live on an Akamai CDN.
  function pageSite() {
    try { return location.hostname.replace(/^www\./, '') || null; }
    catch (_) { return null; }
  }

  // document.title is very often just the site name, which produced titles like
  // "SoundCloud" for every track on the page. Compare against what the site
  // declares itself to be rather than trying to eyeball it.
  const normName = s => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  function siteNames() {
    const out = [];
    const og = document.querySelector('meta[property="og:site_name"]')?.content;
    const app = document.querySelector('meta[name="application-name"]')?.content;
    if (og) out.push(og);
    if (app) out.push(app);
    const hostName = location.hostname.replace(/^www\./, '').split('.')[0];
    if (hostName) out.push(hostName);
    return out.filter(Boolean);
  }
  function isSiteName(t) {
    const n = normName(t);
    if (!n) return true;
    return siteNames().some(s => normName(s) === n);
  }
  // Sites use both "Track | Site" and "Site: Track", so strip either end.
  function stripSiteAffix(title) {
    let t = (title || '').trim();
    for (const s of siteNames()) {
      const e = s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      t = t.replace(new RegExp('\\s*[|\\-–—:·]\\s*' + e + '\\s*$', 'i'), '');
      t = t.replace(new RegExp('^\\s*' + e + '\\s*[|\\-–—:·]\\s*', 'i'), '');
    }
    if (t === (title || '').trim()) t = t.replace(/\s*[|\-–—]\s*[^|\-–—]+$/, '').trim();
    return t.trim();
  }

  // Generic link and button words that say nothing about the track.
  const JUNK = /^(download|play|pause|stop|share|copy|link|save|open|close|menu|more|options|edit|delete|remove|like|love|favorite|bookmark|report|flag|info|details|expand|collapse|next|prev|previous|back|forward|mute|unmute|volume|audio|video|file|click|click here|here|loading|load|submit|send|cancel|ok|yes|no|listen|subscribe|settings|help|about|mp3|stream)$/i;
  const VERBISH = /^(download|play|listen( to)?|stream|save|get)( (now|here|it|this|the)?\s*(file|audio|mp3|episode|track|clip|recording)?)?\s*(\([^)]*\))?$/i;
  const flat = s => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  // A usable label, or null. strict: reject single short words (icon labels).
  function label(raw, strict) {
    const t = flat(raw);
    if (t.length < 3 || t.length > 160) return null;
    if (/^(https?:)?\/\//i.test(t)) return null;
    if (/^[^\s/]+\.(mp3|wav|ogg|oga|flac|aac|m4a|opus|wma|webm)$/i.test(t)) return null;  // a bare filename: cleanFilename does it better
    if (JUNK.test(t) || VERBISH.test(t)) return null;
    if (strict && !/\s/.test(t) && t.length < 12) return null;
    if (isSiteName(t)) return null;
    return t;
  }

  const normUrl = u => { try { const x = new URL(String(u), location.href); x.hash = ''; return x.href; } catch (_) { return String(u); } };
  const noQuery = u => u.split('?')[0];
  const sameFile = (a, b) => { a = normUrl(a); b = normUrl(b); return a === b || noQuery(a) === noQuery(b); };

  // What the site told the OS is playing. Trusted only for the URL that a
  // media element on the page is actually playing (or on a one-audio page).
  function mediaSessionTitle() {
    try {
      const m = W.navigator.mediaSession?.metadata;
      if (!m || !m.title) return null;
      const title = String(m.title).trim();
      if (!title || title.length > 150) return null;
      const artist = m.artist ? String(m.artist).trim() : '';
      const t = artist && !title.toLowerCase().includes(artist.toLowerCase()) ? artist + ' — ' + title : title;
      return isSiteName(t) ? null : t;
    } catch (_) { return null; }
  }
  function mediaFor(url) {
    try {
      for (const m of document.querySelectorAll('audio,video')) {
        if (m.currentSrc === url || m.src === url) return m;
        for (const s of m.querySelectorAll('source')) if (s.src === url) return m;
      }
    } catch (_) {}
    return null;
  }
  function isPlaying(url) {
    try { return [...document.querySelectorAll('audio,video')].some(m => m.currentSrc === url && (!m.paused || m.currentTime > 0)); }
    catch (_) { return false; }
  }

  // JSON-LD. Only a block whose contentUrl IS this file names it; the page's
  // featured episode is not every link's title. `any` (one-audio pages only)
  // takes the first audio object.
  const AUDIO_LD_TYPES = /^(AudioObject|PodcastEpisode|MusicRecording|Episode|Clip|RadioEpisode)$/i;
  function fromJsonLd(url, any) {
    try {
      let exact = null, first = null;
      const walk = node => {
        if (!node || typeof node !== 'object') return;
        if (Array.isArray(node)) { node.forEach(walk); return; }
        const types = [].concat(node['@type'] || []);
        if (types.some(t => AUDIO_LD_TYPES.test(String(t)))) {
          const name = typeof node.name === 'string' ? node.name : typeof node.headline === 'string' ? node.headline : null;
          if (name && name.trim()) {
            const targets = [].concat(node.contentUrl || [], node.embedUrl || [])
              .concat(...[].concat(node.associatedMedia || [], node.audio || []).map(m => m && typeof m === 'object' ? [].concat(m.contentUrl || []) : []));
            if (!exact && targets.some(t => typeof t === 'string' && sameFile(t, url))) exact = name.trim();
            if (!first) first = name.trim();
          }
        }
        Object.values(node).forEach(walk);
      };
      document.querySelectorAll('script[type="application/ld+json"]').forEach(b => { try { walk(JSON.parse(b.textContent)); } catch (_) {} });
      const t = exact || (any ? first : null);
      return t && !isSiteName(t) ? t : null;
    } catch (_) { return null; }
  }

  // Microdata, from the element's own item scope only.
  function fromMicrodata(el) {
    try {
      const scope = el?.closest?.('[itemtype*="AudioObject"],[itemtype*="PodcastEpisode"],[itemtype*="MusicRecording"]');
      if (!scope) return null;
      const n = scope.querySelector('[itemprop="name"]');
      return label(n?.getAttribute('content') || n?.textContent, false);
    } catch (_) { return null; }
  }

  // Distinct audio URLs inside a node: links to audio files and media elements.
  function audioUrlsIn(node, into) {
    const set = into || new Set();
    if (!node || !node.querySelectorAll) return set;
    const visit = n => {
      if (n.tagName === 'A') { if (isAudioUrl(n.href)) set.add(noQuery(n.href)); return; }
      const s = n.currentSrc || n.src || n.querySelector?.('source[src]')?.src || '';
      if (n.tagName === 'AUDIO') set.add(s ? noQuery(s) : 'audio#' + set.size);
      else if (s && looksLikeAudio(s)) set.add(noQuery(s));
    };
    try {
      if (node.matches && node.matches('a[href],audio,video')) visit(node);
      node.querySelectorAll('a[href],audio,video').forEach(visit);
    } catch (_) {}
    return set;
  }
  let pageCountAt = 0, pageCount = 0;
  function pageAudioCount() {
    if (Date.now() - pageCountAt < 400) return pageCount;
    const set = audioUrlsIn(document.body || document.documentElement);
    sourceUrls.forEach(u => set.add(noQuery(u)));
    pageCount = set.size; pageCountAt = Date.now();
    return pageCount;
  }

  // The words a link shows, or its accessible name.
  function linkLabel(a) {
    return label(a.textContent, false) || label(a.getAttribute('aria-label'), true) || label(a.getAttribute('title'), true);
  }

  // A label next to the element: its own name, a heading right before it, or a
  // title inside the smallest container that holds no other audio. Never the
  // page's H1, and never a heading shared by several tracks.
  const HEAD_SEL = 'h2,h3,h4,h5,h6,figcaption,[itemprop="name"],[class*="title" i],[class*="track-name" i],[class*="trackname" i],[class*="song-name" i]';
  function nearbyLabel(el) {
    if (!el || !el.getAttribute) return null;
    let t = label(el.getAttribute('aria-label'), true) || label(el.getAttribute('title'), true);
    if (t) return t;
    try {
      const lb = el.getAttribute('aria-labelledby');
      if (lb) { t = label(lb.split(/\s+/).map(id => document.getElementById(id)?.textContent || '').join(' '), false); if (t) return t; }
      if (el.id) { const l = document.querySelector('label[for="' + CSS.escape(el.id) + '"]'); t = l && label(l.textContent, false); if (t) return t; }
    } catch (_) {}
    // Pass 1: a heading or title — right before the element, or inside the
    // smallest container that holds only this audio.
    let node = el;
    for (let depth = 0; depth < 6 && node; depth++) {
      let sib = node.previousElementSibling;
      for (let i = 0; i < 3 && sib; i++, sib = sib.previousElementSibling) {
        if (audioUrlsIn(sib).size) break;
        if (/^H[2-6]$/.test(sib.tagName) || (sib.matches && sib.matches(HEAD_SEL))) {
          t = label(sib.textContent, true);
          if (t && t.length <= 120) return t;
        }
      }
      const parent = node.parentElement;
      if (!parent || parent === document.body || parent === document.documentElement) break;
      if (audioUrlsIn(parent).size > 1) break;   // it lists other audio too: its title is not this track's
      t = label(parent.getAttribute('aria-label'), true);
      if (t) return t;
      try {
        for (const h of parent.querySelectorAll(HEAD_SEL)) {
          if (h === el || h.contains(el) || el.contains(h)) continue;
          t = label(h.getAttribute('aria-label'), true) || label(h.textContent, true);
          if (t && t.length <= 120) return t;
        }
      } catch (_) {}
      node = parent;
    }
    // Pass 2: short text just before the element or its container.
    node = el;
    for (let depth = 0; depth < 2 && node && node !== document.body; depth++) {
      const sib = node.previousElementSibling;
      if (sib && !audioUrlsIn(sib).size && /^(P|SPAN|LABEL|STRONG|B|EM|FIGCAPTION|DT)$/.test(sib.tagName)) {
        t = label(sib.textContent, true);
        if (t && t.length <= 80) return t;
      }
      node = node.parentElement;
      if (node && audioUrlsIn(node).size > 1) break;
    }
    return null;
  }

  // Page-level metadata describes the page, so it only names a track when the
  // page has one audio.
  function pageLevelTitle(url) {
    const ms = mediaSessionTitle();
    if (ms) return ms;
    const ld = fromJsonLd(url, true);
    if (ld) return ld;
    const og = document.querySelector('meta[property="og:title"]')?.content?.trim();
    if (og && !isSiteName(og)) { const s = label(stripSiteAffix(og), false); if (s) return s; }
    const doc = document.title?.trim();
    if (doc && !isSiteName(doc)) { const s = label(stripSiteAffix(doc), false); if (s && s.length < 90) return s; }
    return null;
  }

  // kind: 'link' (an <a href>), 'media' (an <audio>/<video>), 'found' (a URL
  // the page loaded, no element).
  function extractName(url, el, kind) {
    let t = null;
    try {
      if (kind === 'link' && el) {
        t = linkLabel(el) || fromJsonLd(url) || nearbyLabel(el);
      } else {
        const media = el || mediaFor(url);
        t = (isPlaying(url) && mediaSessionTitle()) || fromJsonLd(url) || fromMicrodata(media) || (media && nearbyLabel(media));
        if (!t) {
          const a = [...document.querySelectorAll('a[href]')].find(x => x.href === url);
          if (a) t = linkLabel(a) || nearbyLabel(a);
        }
      }
      if (!t && pageAudioCount() <= 1) t = pageLevelTitle(url);
    } catch (_) {}
    t = t || cleanFilename(url);
    if (!t) { try { t = decodeURIComponent(String(url).split('/').pop().split('?')[0]).slice(0, 60); } catch (_) {} }
    t = flat(t) || 'Untitled audio';
    return t.length > 140 ? t.slice(0, 139) + '…' : t;
  }

  // ===== STYLES (inside the shadow root only) =====
  const CSS = `
:host{all:initial !important;display:block !important;position:fixed !important;right:0 !important;bottom:0 !important;left:auto !important;top:auto !important;width:0 !important;height:0 !important;margin:0 !important;padding:0 !important;border:0 !important;overflow:visible !important;z-index:2147483647 !important;transform:none !important;filter:none !important;contain:none !important;opacity:1 !important;visibility:visible !important;pointer-events:none !important}
*,*::before,*::after{box-sizing:border-box}
[hidden]{display:none !important}
.root{
  --bg:#0E0F13;--surface:#17191F;--raised:#1F222A;--line:#2A2E38;--ink:#EEF0F4;--muted:#A3AABA;--faint:#6E7586;
  --panel:var(--surface);--hover:var(--raised);--focus:#3D7BF0;--tone:#F07A2B;--on-tone:#fff;
  --shadow:0 24px 56px -16px rgba(0,0,0,.7),0 6px 18px rgba(0,0,0,.35);
  --sans:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;
  --mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
  --ease:150ms ease-out;
  color-scheme:dark;font:400 13px/1.4 var(--sans);color:var(--ink);text-align:left;
  -webkit-font-smoothing:antialiased;-moz-osx-font-smoothing:grayscale;-webkit-text-size-adjust:100%;text-size-adjust:100%;
}
@media (prefers-color-scheme:light){.root{
  --bg:#FFFFFF;--surface:#F6F7FA;--raised:#FFFFFF;--line:#E4E7EE;--ink:#0C1222;--muted:#5A6378;--faint:#8A92A6;
  --panel:#FFFFFF;--hover:var(--surface);
  --shadow:0 24px 56px -20px rgba(12,18,34,.30),0 4px 14px rgba(12,18,34,.08);
  color-scheme:light;
}}
button{font:inherit;color:inherit;margin:0;-webkit-tap-highlight-color:transparent;touch-action:manipulation}
button:focus{outline:none}
button:focus-visible{outline:2px solid var(--focus);outline-offset:2px}
svg{display:block;flex:none}
.disc,.mark,.art{background:linear-gradient(140deg,var(--tone),color-mix(in oklab,var(--tone) 58%,#000));color:#fff}
.disc,.mark{color:var(--on-tone)}

/* pill */
/* Top centre, where it has always been: out of the way of page content, and where the eye
   lands after pressing V. The panel drops down under it; toasts sit at the bottom centre so
   an open panel never covers them. */
.dock{position:fixed;left:0;right:0;top:calc(12px + env(safe-area-inset-top,0px));display:flex;justify-content:center;pointer-events:none}
.pill{pointer-events:auto;display:inline-flex;align-items:center;gap:9px;height:44px;padding:0 13px 0 6px;border-radius:999px;border:1px solid var(--line);background:var(--raised);color:var(--ink);box-shadow:var(--shadow);font:600 13px/1 var(--sans);letter-spacing:.005em;cursor:pointer;user-select:none;-webkit-user-select:none;transition:background-color var(--ease),transform var(--ease);animation:drop var(--ease)}
.pill:active{transform:scale(.97)}
.disc{width:32px;height:32px;border-radius:999px;display:grid;place-items:center;box-shadow:inset 0 0 0 1px rgba(255,255,255,.12)}
.lbl{font-variant-numeric:tabular-nums;white-space:nowrap}
.chev{display:grid;place-items:center;color:var(--muted);transition:transform var(--ease)}
.pill[aria-expanded="true"] .chev{transform:rotate(180deg)}

/* toasts */
.toasts{position:fixed;left:0;right:0;bottom:calc(16px + env(safe-area-inset-bottom,0px));margin:0 auto;width:max-content;max-width:min(360px,calc(100vw - 32px));display:flex;flex-direction:column;align-items:center;gap:8px;pointer-events:none}
.toast{pointer-events:auto;display:flex;align-items:flex-start;gap:9px;padding:11px 14px 11px 12px;border-radius:12px;border:1px solid var(--line);background:var(--raised);color:var(--ink);box-shadow:var(--shadow);font:500 13px/1.4 var(--sans);animation:rise var(--ease);transition:opacity var(--ease),transform var(--ease)}
.toast svg{margin-top:1px}
.toast[data-kind="ok"] svg{color:#2FA86A}
.toast[data-kind="warn"] svg{color:#F07A2B}
.toast[data-kind="info"] svg{color:var(--muted)}
.toast.out{opacity:0;transform:translateY(4px)}

/* panel */
.panel{pointer-events:auto;position:fixed;left:0;right:0;margin:0 auto;top:calc(64px + env(safe-area-inset-top,0px));width:372px;max-height:min(560px,calc(100vh - 84px));display:flex;flex-direction:column;background:var(--panel);border:1px solid var(--line);border-radius:12px;box-shadow:var(--shadow);overflow:hidden;animation:drop var(--ease)}
.panel:focus{outline:none}
.nopill .panel{top:calc(12px + env(safe-area-inset-top,0px));max-height:min(560px,calc(100vh - 32px))}
.head{flex:none;display:flex;flex-direction:column;gap:12px;padding:12px 10px 14px 16px;border-bottom:1px solid var(--line)}
.top{display:flex;align-items:center;gap:10px;min-height:40px}
.mark{flex:none;width:26px;height:26px;border-radius:8px;display:grid;place-items:center}
.mark svg{width:14px;height:14px}
.ttl{margin:0;min-width:0;font:650 15px/1.25 var(--sans);letter-spacing:-.005em;color:var(--ink);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.num{flex:none;font:500 12px/1 var(--mono);color:var(--muted);background:var(--hover);border:1px solid var(--line);border-radius:999px;padding:4px 8px}
.x{flex:none;margin-left:auto;width:40px;height:40px;display:grid;place-items:center;border:0;border-radius:10px;background:transparent;color:var(--muted);cursor:pointer;transition:background-color var(--ease),color var(--ease)}
.acts{display:flex;gap:8px;padding-right:6px}
.btn{flex:1;min-width:0;height:40px;padding:0 14px;display:inline-flex;align-items:center;justify-content:center;gap:8px;border-radius:10px;border:1px solid var(--line);background:transparent;color:var(--ink);font:600 13px/1 var(--sans);white-space:nowrap;cursor:pointer;transition:background-color var(--ease),border-color var(--ease)}
.btn.primary{background:var(--ink);border-color:var(--ink);color:var(--panel)}
.btn:disabled,.btn.primary:disabled{cursor:default;background:transparent;border-color:var(--line);color:var(--muted);opacity:.7}

.list{flex:1 1 auto;min-height:0;overflow-y:auto;overscroll-behavior:contain;padding:6px;scrollbar-width:thin;scrollbar-color:var(--line) transparent}
.list::-webkit-scrollbar{width:10px}
.list::-webkit-scrollbar-thumb{background:var(--line);border-radius:10px;border:3px solid var(--panel)}
.row{display:flex;align-items:center;border-radius:10px;transition:background-color var(--ease)}
.main{flex:1;min-width:0;display:flex;align-items:center;gap:12px;min-height:58px;padding:8px 6px 8px 8px;border:0;border-radius:10px;background:transparent;text-align:left;cursor:pointer}
.art{position:relative;flex:none;width:40px;height:40px;border-radius:10px;overflow:hidden;box-shadow:inset 0 0 0 1px rgba(255,255,255,.10)}
.art svg{width:100%;height:100%}
.txt{min-width:0;display:flex;flex-direction:column;gap:3px}
.t{font:560 13.5px/1.3 var(--sans);color:var(--ink);overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow-wrap:anywhere}
.m{font:400 12px/1.3 var(--sans);color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.m b{font:500 11px/1 var(--mono);letter-spacing:.02em;color:var(--muted)}
.add{flex:none;margin-right:4px;min-width:40px;height:40px;padding:0;display:inline-flex;align-items:center;justify-content:center;gap:6px;border:0;border-radius:10px;background:transparent;color:var(--ink);cursor:pointer;white-space:nowrap}
.ring{width:32px;height:32px;display:grid;place-items:center;border-radius:999px;border:1px solid var(--line);background:var(--panel);transition:background-color var(--ease),border-color var(--ease)}
.row.added .add{padding:0 10px;color:var(--muted);font:600 12px/1 var(--sans)}
.row.added .add svg{color:#2FA86A}

.state{margin:0;padding:30px 28px 32px;text-align:center;color:var(--muted);font:400 13px/1.55 var(--sans);text-wrap:pretty}
.eq{display:inline-flex;gap:3px;align-items:flex-end;height:13px;margin-right:9px;vertical-align:-1px}
.eq i{display:block;width:3px;height:5px;border-radius:2px;background:var(--tone);animation:eq 900ms ease-in-out infinite}
.eq i:nth-child(2){animation-delay:-300ms}
.eq i:nth-child(3){animation-delay:-600ms}
kbd{display:inline-block;min-width:22px;padding:2px 6px 1px;margin:0 1px;border-radius:6px;border:1px solid var(--line);border-bottom-width:2px;background:var(--hover);font:600 12px/1.3 var(--mono);color:var(--ink);text-align:center}

/* hover only where there is a real pointer: a tap must not leave rows tinted */
@media (hover:hover){
  .pill:hover{background:color-mix(in oklab,var(--raised) 93%,var(--ink))}
  .x:hover{background:var(--hover);color:var(--ink)}
  .btn:hover{background:var(--hover)}
  .btn.primary:hover{background:color-mix(in oklab,var(--ink) 86%,var(--panel))}
  .row:hover{background:var(--hover)}
  .add:hover .ring,.main:hover + .add .ring{background:color-mix(in oklab,var(--tone) 16%,var(--panel));border-color:color-mix(in oklab,var(--tone) 50%,var(--line))}
  .row.added .add:hover{color:var(--ink)}
  .btn:disabled:hover,.btn.primary:disabled:hover{background:transparent}
}
@keyframes rise{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}
@keyframes drop{from{opacity:0;transform:translateY(-6px)}to{opacity:1;transform:none}}
@keyframes eq{0%,100%{height:4px}50%{height:13px}}
@media (max-width:440px){
  .panel{left:12px;right:12px;width:auto;max-height:calc(100vh - 84px)}
}
@media (prefers-reduced-motion:reduce){*,*::before,*::after{animation:none !important;transition:none !important}}
`;

  // ===== UI =====
  const host = document.createElement('bt-audio');
  host.id = HOST_ID;
  const shadow = host.attachShadow({ mode: 'open' });
  (function applyStyles() {
    // A constructed sheet is not subject to the page's style-src CSP; a <style>
    // inside the shadow root is the fallback where adopting is refused.
    try {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(CSS);
      shadow.adoptedStyleSheets = [sheet];
      if (shadow.adoptedStyleSheets.length === 1) return;
    } catch (_) {}
    const st = document.createElement('style');
    st.textContent = CSS;
    shadow.appendChild(st);
  })();
  const ui = document.createElement('div');
  ui.className = 'root nopill';
  ui.innerHTML =
    '<div class="dock">'
  +   '<div class="toasts" role="status" aria-live="polite"></div>'
  +   '<button class="pill" type="button" aria-expanded="false" aria-controls="panel" hidden>'
  +     '<span class="disc">' + I.note + '</span><span class="lbl">Audio</span><span class="chev">' + I.chev + '</span>'
  +   '</button>'
  + '</div>'
  + '<section class="panel" id="panel" role="dialog" aria-labelledby="ttl" tabindex="-1" hidden>'
  +   '<header class="head">'
  +     '<div class="top">'
  +       '<span class="mark" aria-hidden="true">' + I.note + '</span>'
  +       '<h2 class="ttl" id="ttl">Audio on this page</h2>'
  +       '<span class="num" aria-hidden="true">0</span>'
  +       '<button class="x" type="button" data-act="close" aria-label="Close">' + I.x + '</button>'
  +     '</div>'
  +     '<div class="acts">'
  +       '<button class="btn primary" type="button" data-act="all" disabled>' + I.all + '<span>Add all</span></button>'
  +       '<button class="btn" type="button" data-act="open">' + I.open + '<span>Open playlist</span></button>'
  +     '</div>'
  +   '</header>'
  +   '<div class="list" role="list" aria-labelledby="ttl" hidden></div>'
  +   '<p class="state"></p>'
  + '</section>';
  shadow.appendChild(ui);
  const $ = sel => ui.querySelector(sel);
  const pill = $('.pill'), lblEl = $('.lbl'), panel = $('.panel'), listEl = $('.list'), stateEl = $('.state');
  const numEl = $('.num'), allBtn = $('[data-act="all"]'), toastsEl = $('.toasts');
  const rows = new Map();           // url -> row element
  let panelOpen = false;
  let restoreFocus = null;

  function mount() {
    if (host.isConnected) return;
    (document.documentElement || document.body).appendChild(host);
  }

  pill.addEventListener('click', () => togglePanel(false));
  // Earliest hint that a track is about to be sent — re-ask now so the
  // synchronous decision on the click itself is working off a fresh answer.
  pill.addEventListener('pointerenter', () => { refreshPlayerOpen(); });
  $('[data-act="close"]').addEventListener('click', () => closePanel());
  allBtn.addEventListener('click', () => sendTracks(sources.slice()));
  // The only control that brings the player forward — adds stay in the page.
  $('[data-act="open"]').addEventListener('click', () => { openPlayerWindow(); closePanel(); });
  // A copy in another world asks this one to toggle (see ONE INSTANCE).
  on(host, 'bt-audio:toggle', e => { e.preventDefault(); togglePanel(true); });

  // Esc or a click outside closes the panel.
  on(document, 'pointerdown', e => {
    if (!panelOpen) return;
    const path = e.composedPath ? e.composedPath() : [];
    if (!path.includes(host)) closePanel();
  }, true);
  on(document, 'keydown', e => {
    if (e.key !== 'Escape' || !panelOpen) return;
    const inside = (e.composedPath ? e.composedPath() : []).includes(host);
    closePanel();
    if (inside) e.stopPropagation();
  }, true);

  function openPanel(focus) {
    mount();
    if (panelOpen) return;
    panelOpen = true;
    panel.hidden = false;
    pill.setAttribute('aria-expanded', 'true');
    updatePill();
    renderState();
    if (focus) {
      const a = document.activeElement;
      restoreFocus = a && a !== host && a !== document.body ? a : null;
      try { panel.focus({ preventScroll: true }); } catch (_) {}
    }
    if (!looking) later(scan, 0);
    refreshPlayerOpen();
  }
  function closePanel() {
    if (!panelOpen) return;
    panelOpen = false;
    panel.hidden = true;
    pill.setAttribute('aria-expanded', 'false');
    updatePill();
    if (shadow.activeElement) {
      try { if (restoreFocus && restoreFocus.isConnected) restoreFocus.focus({ preventScroll: true }); } catch (_) {}
      try { if (shadow.activeElement) shadow.activeElement.blur(); } catch (_) {}
    }
    restoreFocus = null;
  }
  function togglePanel(focus) { mount(); if (panelOpen) closePanel(); else openPanel(focus); }

  // Shown while audio is known, and while the panel is open (it is the toggle).
  function updatePill() {
    const n = sources.length;
    pill.hidden = !(n > 0 || panelOpen);
    ui.classList.toggle('nopill', pill.hidden);
    lblEl.textContent = n ? n + ' audio' : 'Audio';
    pill.dataset.count = String(n);
    numEl.textContent = String(n);
    allBtn.disabled = !n;
    if (n) { const t = toneOf(sources[0].url); ui.style.setProperty('--tone', t); ui.style.setProperty('--on-tone', onTone(t)); }
  }
  function renderState() {
    const n = sources.length;
    listEl.hidden = n === 0;
    stateEl.hidden = n > 0;
    if (n) return;
    stateEl.innerHTML = looking
      ? '<span class="eq" aria-hidden="true"><i></i><i></i><i></i></span>Looking for audio…'
      : 'No audio found yet. Play something on the page and press <kbd>V</kbd> again.';
  }

  function addRow(s) {
    const row = document.createElement('div');
    row.className = 'row';
    row.setAttribute('role', 'listitem');
    row.dataset.url = s.url;
    row.innerHTML = '<button class="main" type="button"><span class="art"></span><span class="txt"><span class="t"></span><span class="m"></span></span></button><button class="add" type="button"></button>';
    const send = () => sendTracks([s]);
    row.querySelector('.main').title = s.url;          // the file's address on hover, as 2.x showed
    row.querySelector('.main').addEventListener('click', send);
    row.querySelector('.add').addEventListener('click', send);
    rows.set(s.url, row);
    paintRow(s);
    listEl.appendChild(row);
  }
  function paintRow(s) {
    const row = rows.get(s.url);
    if (!row) return;
    const tone = toneOf(s.url);
    row.style.setProperty('--tone', tone);
    const art = row.querySelector('.art');
    const letter = firstLetter(s.title);
    if (art.dataset.l !== letter) { art.innerHTML = artSvg(s.url, s.title); art.dataset.l = letter; }
    row.querySelector('.t').textContent = s.title;
    row.querySelector('.m').innerHTML = '<b>' + esc(s.kind) + '</b> · from ' + esc(s.site || 'this page');
    row.querySelector('.main').title = s.title + '\n' + s.url;
    const added = inQueue.has(s.url);
    row.classList.toggle('added', added);
    const add = row.querySelector('.add');
    add.innerHTML = added ? I.check + '<span>Added</span>' : '<span class="ring">' + I.plus + '</span>';
    add.setAttribute('aria-label', added ? 'Added: ' + s.title + '. Add again' : 'Add ' + s.title + ' to the queue');
  }
  function repaint(url) { const s = sources.find(x => x.url === url); if (s) paintRow(s); }

  // ===== TOASTS =====
  function toast(text, kind) {
    mount();
    const t = document.createElement('div');
    t.className = 'toast';
    t.dataset.kind = kind || 'ok';
    t.innerHTML = kind === 'warn' ? I.warn : kind === 'info' ? I.note : I.check;
    t.appendChild(document.createTextNode(text));
    toastsEl.appendChild(t);
    while (toastsEl.children.length > 3) toastsEl.firstElementChild.remove();
    later(() => { t.classList.add('out'); later(() => t.remove(), 180); }, kind === 'warn' ? TOAST_MS + 2400 : TOAST_MS);
  }
  const shortTitle = t => t.length > 34 ? t.slice(0, 32) + '…' : t;

  /* ===== SEND TRACKS =====
     Two independent delivery paths, because either one can be missing:

       postMessage -> the open player window
         Works with no extension at all. This is the path that must never be
         skipped — it is the only one that exists for a plain Tampermonkey
         install, and inside BumbleTap.

       ext-queue-add -> chrome.storage, via the relay
         Durable across reloads and readable from every site, which
         postMessage is not. The worker pushes the new queue to every tab.

     addTrack() in the player dedupes by URL, so running both paths never
     doubles a track. The player answers each addMany with
     {type:'added', count, requested}; that answer, not the click, decides
     between "Added to queue" and "Already in queue". */

  const EXT_TIMEOUT = 700;

  let extSeq = 0;
  const extWaiting = Object.create(null);
  let playerOpen = false;        // cached so the click decision is synchronous
  let extAlive = false;

  on(W, 'message', e => {
    const d = e.data;
    if (!d || typeof d !== 'object' || d.__afp !== 1 || !d.reply) return;
    // Worker push: a player tab opened or closed anywhere. Unsolicited, so it
    // carries no id — this is what keeps the cache below from going stale.
    if (d.type === 'ext-player-state') { extAlive = true; playerOpen = !!d.open; return; }
    const w = extWaiting[d.id];
    if (w) { delete extWaiting[d.id]; w(d); }
  });

  function extCall(type, payload) {
    return new Promise(resolve => {
      const id = 'p' + (++extSeq);
      extWaiting[id] = resolve;
      try { W.postMessage(Object.assign({ __afp: 1, type: type, id: id }, payload || {}), '*'); }
      catch (_) {}
      later(() => {
        if (extWaiting[id]) { delete extWaiting[id]; resolve(null); }
      }, EXT_TIMEOUT);
    });
  }

  /* ===== IS A PLAYER OPEN? =====
     The answer has to be known BEFORE the click, not fetched during it: opening
     a window is only allowed while the click still counts as user activation, so
     the decision must be synchronous and therefore reads a cache. Kept fresh
     three ways: the worker pushes changes (above), we re-ask whenever this page
     comes back to the foreground, and we re-ask on the first hint of intent —
     hovering the pill or opening the panel. */
  function refreshPlayerOpen() {
    return extCall('ext-player-open').then(r => {
      if (r && r.ok) { extAlive = true; playerOpen = !!r.open; }
      return playerOpen;
    });
  }

  on(W, 'focus', () => { refreshPlayerOpen(); });
  on(document, 'visibilitychange', () => { if (!document.hidden) refreshPlayerOpen(); });

  function popupFeatures() {
    const left = W.screenX + W.innerWidth - POPUP_W - 40, top = W.screenY + 60;
    return 'popup=yes,width=' + POPUP_W + ',height=' + POPUP_H + ',left=' + left + ',top=' + top
         + ',resizable=yes,scrollbars=no,menubar=no,toolbar=no,location=no,status=no';
  }

  let popup = null;
  let ready = false;      // the player has answered our handshake
  const pending = [];     // { track, batch } buffered until a player answers
  const inFlight = [];    // addMany posts waiting for their 'added' reply

  /* ===== ACQUIRE THE PLAYER WINDOW =====
     Opening by NAME rather than '_blank' is what stops every add from spawning
     a duplicate. The player sets window.name = '__afp_player' as its first
     statement precisely so a named open can find it again.

     The URL is deliberately empty. W.open(PLAYER_URL, name) would *navigate*
     an existing player, restarting whatever is playing. W.open('', name)
     returns the live window untouched and only creates a blank one when there
     is genuinely nothing there — which we then send to the player URL
     ourselves. Reading w.location is the newness test: a blank window we just
     opened is same-origin and readable, a loaded player is cross-origin and
     throws.

     keepFocus: adding a track should not yank the user out of the page they
     are reading, so take focus straight back. The Open playlist button passes
     false — there the user asked to see it. */
  function acquirePlayer(keepFocus) {
    if (popup && !popup.closed) return popup;   // known-good, handshake still valid

    let w = null;
    try { w = W.open('', '__afp_player', popupFeatures()); } catch (_) { w = null; }
    if (!w) return null;                         // blocked: the caller says so

    // Any window we did not already hold a live reference to is unproven: it may
    // be mid-load with no listener attached, so it must answer before we flush.
    ready = false;

    let blank = false;
    try { blank = !w.location.href || w.location.href === 'about:blank'; } catch (_) { blank = false; }
    if (blank) {
      // #show tells the player the user asked to LOOK at it, so that a window
      // which turns out to be a duplicate knows whether surfacing the incumbent
      // is wanted or just an interruption.
      try { w.location.href = PLAYER_URL + (keepFocus ? '' : '#show'); } catch (_) { return null; }
    }
    popup = w;
    playerOpen = true;
    if (keepFocus) { try { W.focus(); } catch (_) {} }
    return w;
  }

  function openPlayerWindow() {
    const w = acquirePlayer(false);
    if (!w) { toast('Pop-up blocked. Allow pop-ups for this site, then press Open playlist again.', 'warn'); return null; }
    try { w.focus(); } catch (_) {}
    // This is the escape hatch offered when delivery failed, so it has to
    // actually drain the buffer rather than just show the window.
    if (pending.length) { if (ready) flushPending(); else handshake(); }
    return w;
  }

  function flushPending() {
    if (!pending.length || !popup || popup.closed) return;
    const items = pending.splice(0, pending.length);
    const tracks = items.map(i => i.track);
    const batches = [...new Set(items.map(i => i.batch))];
    const now = Date.now();
    while (inFlight.length && now - inFlight[0].at > 20000) inFlight.shift();
    inFlight.push({ win: popup, batches, n: tracks.length, at: now });
    try { popup.postMessage({ __afp: 1, type: 'addMany', tracks: tracks }, '*'); }
    catch (_) { inFlight.pop(); pending.unshift(...items); }
  }

  on(W, 'message', e => {
    const d = e.data;
    if (!d || typeof d !== 'object' || d.__afp !== 1 || d.reply) return;
    if (d.type === 'ready' || d.type === 'pong') {
      // Only adopt an unsolicited sender when we have nothing — otherwise any
      // page on the site could claim to be the player and swallow our tracks.
      if (e.source && (!popup || popup.closed)) popup = e.source;
      ready = true;
      playerOpen = true;
      flushPending();        // a late 'ready' still delivers what was waiting
      return;
    }
    if (d.type === 'added') {
      if (!inFlight.length) return;
      let i = inFlight.findIndex(f => f.win === e.source);
      if (i < 0) i = 0;
      const f = inFlight.splice(i, 1)[0];
      const count = Math.max(0, Number(d.count) || 0);
      settle(f.batches, count, Number(d.requested) || f.n);
    }
  });

  /* The player's 'ready' announcement is a single shot fired at load. It is
     missed whenever the window was already open before this page existed, so
     we ping until something answers. A slow player (a blocking font, a slow
     network) used to have its tracks thrown away after 6s; now they wait, and
     the late 'ready' or 'pong' flushes them. */
  let handshaking = false;
  function handshake() {
    if (handshaking) return;            // one loop, however many adds queue up
    handshaking = true;
    let tries = 0;
    const tick = () => {
      if (ready || !popup || popup.closed) { handshaking = false; return; }
      tries++;
      try { popup.postMessage({ __afp: 1, type: 'ping' }, '*'); } catch (_) {}
      if (tries === 24 && pending.length && !extAlive) {
        toast('The player is taking a while to load. Your tracks will be added when it’s ready.', 'info');
        try { console.warn('[AFP] player has not answered yet; keeping ' + pending.length + ' track(s) until it does'); } catch (_) {}
      }
      if (tries < 24 + 90) later(tick, tries < 24 ? 250 : 1000);
      else handshaking = false;          // stop pinging; a late 'ready' still flushes
    };
    later(tick, 250);
  }

  function addedCopy(count, requested) {
    if (requested <= 1) return count > 0 ? 'Added to your playlist' : 'Already in your playlist';
    if (count >= requested) return 'Added ' + requested + ' tracks';
    if (count <= 0) return 'Already in your playlist';
    const dup = requested - count;
    return 'Added ' + count + (count === 1 ? ' track. ' : ' tracks. ') + dup + (dup === 1 ? ' was' : ' were') + ' already in the queue.';
  }

  // A batch is one click (a row or Add all). The first conclusive answer marks
  // its rows Added and toasts once.
  function settle(batches, count, requested) {
    const fresh = batches.filter(b => !b.done);
    batches.forEach(b => { b.done = true; b.urls.forEach(u => { inQueue.add(u); repaint(u); }); });
    if (!fresh.length) return;
    const relay = fresh.reduce((n, b) => n + (b.relayCount || 0), 0);
    const n = Math.max(count, Math.min(relay, requested));
    toast(addedCopy(n, requested), n > 0 ? 'ok' : 'info');
  }

  function sendTracks(list) {
    const tracks = list.filter(s => s && typeof s.url === 'string')
      .map(s => ({ url: s.url, title: s.title || null, site: s.site || pageSite(), page: s.page || location.href.split('#')[0] }));
    if (!tracks.length) return;
    const batch = { urls: tracks.map(t => t.url), done: false, relayCount: 0 };
    tracks.forEach(t => sentUrls.add(t.url));

    /* Reach for a window only when there is reason to believe none exists.

       W.open resolves a window NAME only inside the caller's browsing context
       group, so from a tab that did not open the player it cannot find it and
       makes a second one. The extension answers the question properly — it
       looks for a tab on the player URL, which crosses tabs — so when it says a
       player is open, trust that and let the queue write below be the delivery.
       Only when nothing authoritative says otherwise do we open a window
       ourselves, and that has to happen synchronously, while the click still
       counts as user activation. */
    const live = popup && !popup.closed;
    const openElsewhere = extAlive && playerOpen;
    const w = live ? popup : (openElsewhere ? null : acquirePlayer(true));
    const blocked = !w && !openElsewhere;

    // Path 1: straight to the window we hold. Buffered until it answers. A
    // blocked pop-up keeps the tracks too, for the Open playlist button.
    if (w || blocked) tracks.forEach(t => pending.push({ track: t, batch }));
    if (w) { if (ready) flushPending(); else handshake(); }
    if (blocked) toast('Pop-up blocked. Allow pop-ups for this site, then press Open playlist.', 'warn');

    // Path 2: the durable, cross-site copy.
    extCall('ext-queue-add', { tracks: tracks }).then(r => {
      if (!r || !r.ok) {
        if (extAlive) { try { console.warn('[AFP] queue relay stopped answering; cross-site queue is off'); } catch (_) {} }
        extAlive = false;
        if (w || blocked) return;          // path 1 has them
        /* We skipped opening a window because the extension claimed one was
           open, and then the extension did not answer. Nothing delivered these
           tracks. The user activation is long gone, so keep them and let the
           next add (or Open playlist) flush them. */
        playerOpen = false;
        tracks.forEach(t => pending.push({ track: t, batch }));
        toast('Couldn’t reach your playlist. Press Open playlist to send your tracks.', 'warn');
        return;
      }
      extAlive = true;
      batch.relayCount = Number(r.count) || 0;
      if (!w) {                            // the relay was the delivery
        for (let i = pending.length - 1; i >= 0; i--) if (pending[i].batch === batch) pending.splice(i, 1);
        settle([batch], batch.relayCount, tracks.length);
      }
      refreshPlayerOpen();
    });
  }

  // ===== SCAN =====
  // Returns true only when the URL was genuinely new, so callers can avoid
  // re-toasting audio we already know about.
  function addSource(u, t) {
    if (sourceUrls.has(u)) return false;
    sourceUrls.add(u);
    const s = { url: u, title: t, kind: kindOf(u), site: pageSite(), page: location.href.split('#')[0] };
    sources.push(s);
    addRow(s);
    updatePill();
    renderState();
    refineWithID3(u);            // async; upgrades the title in place if tags exist
    return true;
  }

  /* ===== ID3 TITLE REFINEMENT =====
     extractName is synchronous and returns its best DOM-derived guess straight
     away, so the UI never waits. Reading the file's own tags needs network, so
     it runs afterwards and upgrades the title in place — in the panel, in
     tracks still waiting to be sent, and in an open player ('retitle'). */

  const ID3_MAX_CONCURRENT = 2;
  const id3Done = new Set();
  const id3Queue = [];
  let id3Active = 0;

  /* Range-fetch transport, resolved once at startup. Each environment has a
     different CORS escape hatch:

       host           AFP_RANGE_FETCH        whatever the host provides
       Tampermonkey   GM_xmlhttpRequest      ignores CORS outright
       BumbleTap      http()                 the service worker fetches
       Extension      background worker      chrome.runtime 'afp-range'
       Bare page      fetch                  CORS applies; most audio CDNs refuse

     Everything degrades to "no ID3, DOM title only" rather than breaking. */

  // Extension path: content scripts ARE CORS-bound, so the fetch has to happen
  // in the service worker. See EXTENSION-SETUP.md.
  function bgRange(url, start, end) {
    return new Promise(resolve => {
      try {
        chrome.runtime.sendMessage(
          { type: 'afp-range', url, start, end },
          r => {
            if (chrome.runtime.lastError || !r || !r.ok) return resolve(null);
            resolve(new Uint8Array(r.bytes));   // sent as a plain array over the bridge
          }
        );
      } catch (_) { resolve(null); }
    });
  }

  // BumbleTap: http() runs in the service worker with the extension's
  // host_permissions and hands binary bodies back as res.bytes.
  function httpRange(url, start, end) {
    let p;
    try {
      p = http(url, { method: 'GET', headers: { Range: 'bytes=' + start + '-' + end }, responseType: 'arraybuffer' });
    } catch (_) { return Promise.resolve(null); }
    return Promise.resolve(p).then(res => {
      if (!res || (res.status !== 206 && res.status !== 200)) return null;
      let b = res.bytes || (res.arrayBuffer ? new Uint8Array(res.arrayBuffer) : null);
      if (!b) return null;
      // 200 = the server ignored Range and sent the file from byte 0.
      if (res.status === 200 && b.length > end - start + 1) b = b.subarray(start, end + 1);
      return b;
    }, () => null);
  }

  // Last resort. Works only where the host sends permissive CORS headers.
  async function plainRange(url, start, end) {
    try {
      const res = await fetch(url, { headers: { Range: `bytes=${start}-${end}` }, mode: 'cors' });
      if (!res.ok) return null;
      return new Uint8Array(await res.arrayBuffer());
    } catch (_) { return null; }
  }

  // When a privileged transport fails, a same-origin file can still be read
  // with a plain fetch — no CORS involved.
  function sameOriginFallback(primary) {
    return (url, start, end) => Promise.resolve(primary(url, start, end)).then(b => {
      if (b) return b;
      try { if (new URL(url, location.href).origin === location.origin) return plainRange(url, start, end); } catch (_) {}
      return null;
    }, () => null);
  }

  /* MAIN-world path. chrome.runtime is only exposed to the ISOLATED world, so a
     MAIN-world script reaches the background worker through a tiny relay
     content script over postMessage (see EXTENSION-SETUP.md). */
  let bridgeSeq = 0;
  function bridgeRange(url, start, end) {
    return new Promise(resolve => {
      const id = 'afp' + (++bridgeSeq);
      let settled = false;
      const finish = v => {
        if (settled) return;
        settled = true;
        W.removeEventListener('message', onMsg);
        clearTimeout(timer);
        resolve(v);
      };
      const onMsg = e => {
        const d = e.data;
        if (!d || d.__afpBridge !== 1 || d.id !== id || !d.reply) return;
        finish(d.ok && d.bytes ? new Uint8Array(d.bytes) : null);
      };
      W.addEventListener('message', onMsg);
      const timer = setTimeout(() => { finish(null); }, 6000);
      try { W.postMessage({ __afpBridge: 1, id, url, start, end }, '*'); }
      catch (_) { finish(null); }
    });
  }

  /* Host-supplied transport takes priority over everything else:

         AFP_RANGE_FETCH = (url, start, end) => Promise<Uint8Array|null>;

     Resolve null on any failure — never throw. */
  function pickRangeFetcher() {
    if (typeof AFP_RANGE_FETCH === 'function') return AFP_RANGE_FETCH;         // host-provided
    if (typeof GM_xmlhttpRequest === 'function') return gmRange;               // Tampermonkey
    if (typeof http === 'function') return sameOriginFallback(httpRange);      // BumbleTap
    if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage)
      return bgRange;                                                          // isolated content script
    if (typeof AFP_USE_BRIDGE !== 'undefined' && AFP_USE_BRIDGE) return bridgeRange; // MAIN world + relay
    if (typeof fetch === 'function') return plainRange;                        // permissive hosts only
    return null;
  }

  // GM_xmlhttpRequest ignores CORS, which is the entire point of using it here.
  function gmRange(url, start, end) {
    return new Promise(resolve => {
      let settled = false;
      const done = v => { if (!settled) { settled = true; resolve(v); } };
      try {
        GM_xmlhttpRequest({
          method: 'GET', url,
          headers: { Range: `bytes=${start}-${end}` },
          responseType: 'arraybuffer',
          timeout: 8000,
          onload: r => {
            // 206 = Range honoured. 200 = the whole file from byte 0.
            if (r.status !== 206 && r.status !== 200) return done(null);
            let b = r.response ? new Uint8Array(r.response) : null;
            if (b && r.status === 200 && b.length > end - start + 1) b = b.subarray(start, end + 1);
            done(b);
          },
          onerror: () => done(null),
          ontimeout: () => done(null),
          onabort: () => done(null),
        });
      } catch (_) { done(null); }
    });
  }

  function pumpID3() {
    while (id3Active < ID3_MAX_CONCURRENT && id3Queue.length) runID3(id3Queue.shift());
  }

  async function runID3(url) {
    id3Active++;
    try {
      // AFPID3 arrives via @require (Tampermonkey, BumbleTap) or as a separate
      // file listed before this one in the extension's content_scripts array.
      const ID3 = (typeof AFPID3 !== 'undefined') ? AFPID3
                : (typeof W !== 'undefined' && W.AFPID3) ? W.AFPID3 : null;
      if (!ID3 || !rangeFetcher) return;
      const tags = await ID3.readTags(url, rangeFetcher);
      const better = ID3.formatTitle(tags);
      if (!better || ac.signal.aborted) return;

      const src = sources.find(s => s.url === url);
      if (src && better.length > 2 && better !== src.title) {
        src.title = better;
        paintRow(src);
        // Not sent yet: it leaves with the better title.
        pending.forEach(p => { if (p.track.url === url) p.track.title = better; });
        // Already in an open player: rename it there.
        if (sentUrls.has(url) && ready && popup && !popup.closed) {
          try { popup.postMessage({ __afp: 1, type: 'retitle', url: url, title: better }, '*'); } catch (_) {}
        }
        // And in the extension's stored queue, when there is one.
        if (extAlive && sentUrls.has(url)) {
          extCall('ext-queue-get').then(g => {
            if (!g || !g.ok || !Array.isArray(g.queue)) return;
            const t = g.queue.find(x => x.url === url);
            if (!t || t.title === better) return;
            t.title = better;
            extCall('ext-queue-set', { queue: g.queue });
          });
        }
      }
    } catch (_) {
    } finally { id3Active--; pumpID3(); }
  }

  const rangeFetcher = pickRangeFetcher();

  function refineWithID3(url) {
    if (!rangeFetcher) return;                 // no usable transport: DOM titles only
    if (id3Done.has(url) || !/^https?:\/\//i.test(url)) return;
    id3Done.add(url);
    id3Queue.push(url);
    pumpID3();
  }

  /* Resource Timing remembers what the page loaded before we were running —
     the shim that reports dynamic audio has no replay. Best-effort: browsers
     do not list every media request, and the buffer is finite. */
  let perfSeen = 0;
  function scanPerformance() {
    try {
      const list = performance.getEntriesByType('resource');
      if (list.length < perfSeen) perfSeen = 0;        // the page cleared the buffer
      for (let i = perfSeen; i < list.length; i++) {
        const en = list[i], u = en.name;
        if (!u || !/^https?:/i.test(u) || sourceUrls.has(u)) continue;
        const media = en.initiatorType === 'audio' || en.initiatorType === 'video';
        if (isAudioUrl(u) || (media && looksLikeAudio(u))) foundUrl(u, 'REPLAY', null, true);
      }
      perfSeen = list.length;
    } catch (_) {}
  }

  // Every branch checks sourceUrls BEFORE calling extractName: the ancestor
  // walk is not free, and scans run every 3s plus on DOM mutations.
  function scan() {
    if (ac.signal.aborted) return;
    pageCountAt = 0;
    document.querySelectorAll('a[href]').forEach(a => {
      const u = a.href;
      if (!isAudioUrl(u) || sourceUrls.has(u) || !/^https?:/i.test(u)) return;
      addSource(u, extractName(u, a, 'link'));
    });
    // <audio> and <video> elements, by what they are actually playing.
    document.querySelectorAll('audio,video').forEach(el => {
      const s = el.currentSrc || el.src || el.querySelector('source[src]')?.src;
      if (!s || !/^https?:/i.test(s) || sourceUrls.has(s)) return;
      if (el.tagName === 'VIDEO' && !looksLikeAudio(s)) return;
      addSource(s, extractName(s, el, 'media'));
    });
    document.querySelectorAll('video source[type^="audio"]').forEach(el => {
      const s = el.src;
      if (!s || !/^https?:/i.test(s) || sourceUrls.has(s)) return;
      addSource(s, extractName(s, el.closest('video') || el, 'media'));
    });
    scanPerformance();
  }

  // A URL the page loaded or built (interceptors, the shim, Resource Timing).
  function foundUrl(url, source, el, trusted) {
    if (!url || typeof url !== 'string') return;
    let abs;
    try { abs = new URL(url, location.href).href; } catch (_) { return; }
    if (!/^https?:/i.test(abs)) return;
    if (!trusted && !looksLikeAudio(abs)) return;
    if (sourceUrls.has(abs)) return;          // bail before the costly extractName
    if (!el) el = mediaFor(abs);
    const title = extractName(abs, el, el ? 'media' : 'found');
    // Toast only on genuinely new audio found after the first look, and only
    // while the panel (which shows it anyway) is closed.
    if (addSource(abs, title) && !looking && !panelOpen) toast('Found audio: ' + shortTitle(title), 'info');
  }

  /* Discoveries reported from the MAIN world. Isolated worlds share the
     window's message target, so a postMessage from MAIN is received here even
     though the two can't see each other's globals. Two senders:
       {__afpFound:1, url, source}                              this file, AFP_ROLE='intercept'
       {source:'afp-intercept', type:'AFP_MEDIA_URL', url, via} BumbleTap's afp-intercept.js */
  on(W, 'message', e => {
    const d = e.data;
    if (!d || typeof d !== 'object' || typeof d.url !== 'string') return;
    if (d.__afpFound === 1) { foundUrl(d.url, typeof d.source === 'string' ? d.source : 'STREAM', null, false); return; }
    // The shim reports video and manifests too; keep what looks like audio.
    if (d.source === 'afp-intercept' && d.type === 'AFP_MEDIA_URL') foundUrl(d.url, typeof d.via === 'string' ? d.via : 'STREAM', null, false);
  });

  // ===== DEEP INTERCEPTORS =====
  // Catch audio that sites create dynamically via JS — no DOM links to find.

  function looksLikeAudio(url) {
    if (!url || typeof url !== 'string' || !/^https?:\/\//i.test(url)) return false;
    let path;
    try { const u = new URL(url); path = (u.pathname + u.search).toLowerCase(); }
    catch (_) { return false; }
    const clean = path.split('?')[0];

    if (AUDIO_EXTS.some(ext => clean.endsWith('.' + ext))) return true;

    // The loose keyword match is scoped to path+query, never the hostname.
    // Matching the whole URL meant every page on a host like audioboom.com or
    // any site with "stream" in its domain looked like an audio file.
    if (/(^|[\/._-])(stream|audio|listen|podcast|episode)([\/._-]|$)/.test(path)
        && !/\.(html?|php|aspx?|[cm]?jsx?|css|json|xml|png|jpe?g|gif|svg|webp|ico|woff2?|ttf|mp4|m4v|mov|m3u8|mpd|ts)$/.test(clean)) return true;

    if (/[?&](ct|content.?type|type)=audio/.test(path)) return true;
    return false;
  }

  // `trusted` = the response content-type already confirmed audio, so the URL
  // heuristic is skipped. That's the opaque-URL case (/api/v2/media/8f3a91)
  // that sniffing structurally cannot catch.
  function interceptedAudio(url, source, el, trusted) {
    if (el && el.tagName !== 'AUDIO' && el.tagName !== 'VIDEO') el = null;
    if (el && el.tagName === 'AUDIO') trusted = true;
    foundUrl(url, source, el, trusted);
  }

  /* The four page-global patches, installed only where they can actually work.
     In an isolated world they patch objects the page never sees, so there the
     MAIN-world shim reports instead. Takes a sink so the same code serves both
     roles: the MAIN-world copy postMessages its findings, the page-context
     copy (Tampermonkey) handles them inline. */
  function installInterceptors(report) {

    // 1. HTMLMediaElement.prototype.src setter — el.src = "https://…"
    try {
      const srcDesc = Object.getOwnPropertyDescriptor(W.HTMLMediaElement.prototype, 'src');
      if (srcDesc && srcDesc.set) {
        Object.defineProperty(W.HTMLMediaElement.prototype, 'src', {
          set(v) {
            report(v, 'STREAM', this);
            srcDesc.set.call(this, v);
          },
          get() { return srcDesc.get.call(this); },
          configurable: true,
          enumerable: true,
        });
      }
    } catch (e) {}

    // 2. window.Audio constructor — new Audio("https://…")
    try {
      const _Audio = W.Audio;
      W.Audio = function(src) {
        const a = new _Audio(src);
        if (src) report(src, 'STREAM', a);
        return a;
      };
      W.Audio.prototype = _Audio.prototype;
      Object.defineProperty(W.Audio, 'length', { value: _Audio.length });
    } catch (e) {}

    // 3. fetch — responses with an audio content-type
    try {
      const _fetch = W.fetch;
      W.fetch = async function(...args) {
        const res = await _fetch.apply(this, args);
        try {
          if (res.ok) {
            const ct = (res.headers.get('content-type') || '').toLowerCase();
            const raw = typeof args[0] === 'string' ? args[0] : args[0]?.url || '';
            const url = raw ? new URL(raw, location.href).href : '';
            if (ct.includes('audio') || ct.includes('mpeg') || ct.includes('ogg')) {
              report(url, 'FETCH', null, true);
            }
          }
        } catch (e) {}
        return res;
      };
    } catch (e) {}

    // 4. XHR — detected on completion, so 404s and aborted loads stay out.
    try {
      const _open = W.XMLHttpRequest.prototype.open;
      W.XMLHttpRequest.prototype.open = function(method, url, ...rest) {
        try {
          if (typeof url === 'string') {
            const abs = new URL(url, location.href).href;
            if (/^https?:/i.test(abs)) {
              this.addEventListener('load', () => {
                try {
                  if (this.status < 200 || this.status >= 300) return;
                  const ct = (this.getResponseHeader('content-type') || '').toLowerCase();
                  if (ct.includes('audio') || ct.includes('mpeg') || ct.includes('ogg')) {
                    report(abs, 'XHR', null, true);
                  } else if (looksLikeAudio(abs)) {
                    report(abs, 'XHR', null, false);
                  }
                } catch (_) {}
              }, { once: true });
            }
          }
        } catch (_) {}
        return _open.call(this, method, url, ...rest);
      };
    } catch (e) {}
  }

  if (IN_MAIN_WORLD) installInterceptors(interceptedAudio);

  // 5. <audio>/<source> elements added to the DOM
  {
    const mo = new MutationObserver(muts => {
      for (const m of muts) {
        m.addedNodes.forEach(n => {
          if (!n.tagName || n === host) return;
          if (n.tagName === 'AUDIO') {
            const src = n.src || n.querySelector?.('source')?.src;
            if (src && src.startsWith('http')) interceptedAudio(src, 'DOM', n);
            // Also catch .src being set later on this specific element
            n.addEventListener('loadstart', () => { if (n.currentSrc && n.currentSrc.startsWith('http')) interceptedAudio(n.currentSrc, 'DOM', n); }, { once: true, signal: ac.signal });
          }
          if (n.tagName === 'SOURCE') {
            const src = n.src || n.getAttribute('src');
            if (src && src.startsWith('http')) interceptedAudio(src, 'DOM', n.closest('audio') || n);
          }
        });
      }
    });
    mo.observe(document, { childList: true, subtree: true });
    observers.push(mo);
    let t = null;
    const debounced = new MutationObserver(() => { cancel(t); t = later(scan, 300); });
    debounced.observe(document.body || document.documentElement, { childList: true, subtree: true });
    observers.push(debounced);
  }

  // ===== KEYBOARD =====
  // Ctrl+Shift+P: send the selected URL, the copied URL, or one typed in.
  on(document, 'keydown', e => {
    const tg = e.target;
    if (!tg || tg.tagName === 'INPUT' || tg.tagName === 'TEXTAREA' || tg.isContentEditable) return;
    if (e.ctrlKey && e.shiftKey && (e.key === 'p' || e.key === 'P')) {
      e.preventDefault();
      const go = u => {
        u = (u || '').trim();
        if (!u || !/^(https?:)?\/\//i.test(u)) return;
        try { u = new URL(u, location.href).href; } catch (_) { return; }
        sendTracks([{ url: u, title: extractName(u, null, 'found') }]);
      };
      const ask = () => { const u = prompt('Audio URL:'); if (u && u.trim()) go(u); };
      const sel = window.getSelection()?.toString().trim();
      if (sel && /^(https?:)?\/\//i.test(sel)) { go(sel); return; }
      try {
        navigator.clipboard.readText().then(t => { t = t && t.trim(); if (t && /^(https?:)?\/\//i.test(t)) go(t); else ask(); }).catch(ask);
      } catch (_) { ask(); }
    }
  });

  // ===== INSTANCE =====
  function destroy() {
    ac.abort();
    timers.forEach(id => clearTimeout(id)); timers.clear();
    clearInterval(scanTimer);
    observers.forEach(o => { try { o.disconnect(); } catch (_) {} });
    try { host.remove(); } catch (_) {}
    if (globalThis.__btAudio === api) { try { delete globalThis.__btAudio; } catch (_) { globalThis.__btAudio = undefined; } }
  }
  const api = {
    version: AFP_VERSION,
    host: host,
    toggle: () => togglePanel(true),
    open: () => openPanel(true),
    close: () => closePanel(),
    destroy: destroy,
  };
  try { globalThis.__btAudio = api; } catch (_) {}

  // ===== START =====
  mount();
  updatePill();
  renderState();
  // Pressing V is a deliberate action: show the panel now, before the scan.
  if (IN_BUMBLETAP) openPanel(true);
  refreshPlayerOpen();
  later(scan, 30);
  later(() => { scan(); looking = false; renderState(); }, 1200);
  scanTimer = setInterval(scan, SCAN_INTERVAL);
})();
