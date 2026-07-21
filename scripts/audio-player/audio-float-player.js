// ==UserScript==
// @name         Audio Float Player
// @version      2.1.0
// @description  Elegant floating audio player. Detects audio, queues across pages, polished UI.
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
   required files aggressively and will otherwise keep serving the old copy. */

(() => {
  // The page's real window. Falls back to `window` if unsafeWindow is denied,
  // which keeps the UI working even if interception degrades.
  const W = (typeof unsafeWindow !== 'undefined' && unsafeWindow) ? unsafeWindow : window;

  /* Are we actually in the page's world? An injected inline <script> always
     executes in MAIN, so if we can see the global it sets, we're in MAIN too.

     This decides whether the four prototype patches below are worth installing.
     In an isolated world (Chrome USER_SCRIPT or ISOLATED) they would patch
     objects the page never touches and detect nothing — silently. Rather than
     ship dead code that looks like it works, we skip them and rely on
     afp-intercept.js running in MAIN to report discoveries instead. */
  const IN_MAIN_WORLD = (() => {
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
  const AUDIO_EXTS = ['mp3','wav','ogg','flac','aac','m4a','opus','wma','webm'];

  /* ===== ROLE =====
     One file, two jobs, because the two halves must live in different worlds:

       'intercept'  MAIN world. Installs the four page-global patches and
                    postMessages what it finds. No UI, no player state.
       'full'       (default) The player: UI, queue, ID3, popup handoff.

     The extension registers this file twice and sets AFP_ROLE='intercept' on the
     MAIN-world copy. Without the flag it builds the whole player — which is what
     Tampermonkey gets, and there the script is already in page context, so it
     installs the patches inline instead of waiting for a shim to report.

     Registering one copy in each world without this switch would build two UIs. */
  const ROLE = (typeof AFP_ROLE !== 'undefined' && AFP_ROLE) ? String(AFP_ROLE) : 'full';

  /* Version banner — deliberately loud. This script is PASTED into the
     extension, not served, so pushing a fix does not update the running copy.
     A whole round of debugging was lost to exactly that. If the console does
     not show this line with the current version, the extension is running a
     stale paste. */
  const AFP_VERSION = '2.1.0';
  try {
    console.info('[AFP] audio-float-player v' + AFP_VERSION + ' — role: ' + ROLE
      + (IN_MAIN_WORLD ? ' (MAIN world)' : ' (isolated/user-script world)'));
  } catch (_) {}

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
    return;
  }

  const SCAN_INTERVAL = 3000;
  const POPUP_W = 380;
  const POPUP_H = 560;
  const TOAST_MS = 2800;

  // ===== HOSTED PAGES =====
  // Both live in the same GitHub Pages repo. The player MUST be hosted rather
  // than written into an about:blank popup — an about:blank window inherits the
  // opener's origin, which is why the queue used to be trapped on one hostname.
  // Serving it from one fixed origin lets every player window share a queue.
  const PLAYER_URL   = 'https://umershahzeb02.github.io/bumbletap/scripts/audio-player/player.html';
  const PLAYER_ORIGIN = new URL(PLAYER_URL).origin;

  let sources = [];
  let sourceUrls = new Set();
  let pill = null;
  let listPanel = null;
  let toastBox = null;
  let listOpen = false;
  let popup = null;

  // ===== ICONS — page size (14px) =====
  const I = {
    music:    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>',
    play:     '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5.14v14l11-7-11-7z"/></svg>',
    pause:    '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/></svg>',
    chev:     '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><polyline points="6 9 12 15 18 9"/></svg>',
    check:    '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><polyline points="20 6 9 17 4 12"/></svg>',
    ext:      '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>',
  };



  const esc = s => (s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  const isAudioUrl = url => { if(!url)return false; return AUDIO_EXTS.includes(url.split('?')[0].split('#')[0].split('.').pop().toLowerCase())};

  // ===== SMART TITLE EXTRACTION =====
  function cleanFilename(url) {
    let name = decodeURIComponent(url.split('/').pop().split('?')[0].split('#')[0]);
    // Strip extension
    name = name.replace(/\.\w{2,4}$/, '');
    // Replace separators with spaces
    name = name.replace(/[-_+.]/g, ' ');
    // Remove hex hashes (32+ char hex strings)
    name = name.replace(/\b[a-f0-9]{24,}\b/gi, '');
    // Remove lone numbers/IDs
    name = name.replace(/^\d+\s*/, '').replace(/\s*\d+$/, '');
    // Collapse whitespace
    name = name.replace(/\s+/g, ' ').trim();
    // Title case if all lowercase
    if (name && name === name.toLowerCase()) {
      name = name.replace(/\b\w/g, c => c.toUpperCase());
    }
    return name || null;
  }

  // The page the audio was grabbed FROM — not the host serving the file. Those
  // routinely differ: a clip found on bbc.co.uk may live on an Akamai CDN, and
  // the CDN hostname tells you nothing about where you found it. The player
  // can't recover this after the fact, so it has to travel with the track.
  function pageSite() {
    try { return location.hostname.replace(/^www\./, '') || null; }
    catch (_) { return null; }
  }

  // ===== SITE-NAME DETECTION =====
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
    const host = location.hostname.replace(/^www\./, '').split('.')[0];
    if (host) out.push(host);
    return out.filter(Boolean);
  }

  function isSiteName(t) {
    if (!t) return true;
    const n = normName(t);
    if (!n) return true;
    return siteNames().some(s => normName(s) === n);
  }

  // Sites use both "Track | Site" and "Site: Track", so strip either end.
  function stripSiteAffix(title) {
    let t = (title || '').trim();
    for (const s of siteNames()) {
      const esc = s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      t = t.replace(new RegExp('\\s*[|\\-–—:·]\\s*' + esc + '\\s*$', 'i'), '');
      t = t.replace(new RegExp('^\\s*' + esc + '\\s*[|\\-–—:·]\\s*', 'i'), '');
    }
    // Fall back to lopping a trailing " | Anything" segment
    if (t === (title || '').trim()) t = t.replace(/\s*[|\-–—]\s*[^|\-–—]+$/, '').trim();
    return t.trim();
  }

  // ===== TIER 0: the site already told the OS what this is =====
  // Any site with a real player sets mediaSession so lock-screen controls show
  // the right thing. It's the cleanest title available and costs nothing.
  function fromMediaSession() {
    try {
      const m = W.navigator.mediaSession?.metadata;
      if (!m || !m.title) return null;
      const title = String(m.title).trim();
      if (!title || title.length > 150) return null;
      const artist = m.artist ? String(m.artist).trim() : '';
      return artist && !title.toLowerCase().includes(artist.toLowerCase())
        ? `${artist} — ${title}` : title;
    } catch (_) { return null; }
  }

  // ===== TIER 1: structured metadata =====
  const AUDIO_LD_TYPES = /^(AudioObject|PodcastEpisode|MusicRecording|Episode|Clip)$/i;

  function fromJsonLd(url) {
    try {
      const blocks = document.querySelectorAll('script[type="application/ld+json"]');
      const hits = [];
      const walk = node => {
        if (!node || typeof node !== 'object') return;
        if (Array.isArray(node)) { node.forEach(walk); return; }
        const types = [].concat(node['@type'] || []);
        if (types.some(t => AUDIO_LD_TYPES.test(String(t)))) {
          const name = node.name || node.headline;
          if (name && typeof name === 'string') {
            const target = node.contentUrl || node.url || node.associatedMedia?.contentUrl;
            hits.push({ name: name.trim(), exact: !!target && url.includes(String(target).split('?')[0]) });
          }
        }
        Object.values(node).forEach(walk);
      };
      blocks.forEach(b => { try { walk(JSON.parse(b.textContent)); } catch (_) {} });
      if (!hits.length) return null;
      // Prefer a block whose contentUrl actually matches this file
      return (hits.find(h => h.exact) || hits[0]).name || null;
    } catch (_) { return null; }
  }

  function fromMicrodata(el) {
    try {
      let scope = el?.closest?.('[itemtype*="AudioObject"],[itemtype*="PodcastEpisode"],[itemtype*="MusicRecording"]');
      if (!scope) scope = document.querySelector('[itemtype*="AudioObject"],[itemtype*="PodcastEpisode"]');
      if (!scope) return null;
      const n = scope.querySelector('[itemprop="name"]');
      const v = n?.getAttribute('content') || n?.textContent?.trim();
      return v && v.length > 2 && v.length < 150 ? v : null;
    } catch (_) { return null; }
  }

  function extractName(url, el) {
    // Generic/icon title attributes to ignore
    const JUNK_TITLES = /^(download|play|pause|stop|share|copy|link|save|open|close|menu|more|options|edit|delete|remove|like|love|favorite|bookmark|report|flag|info|details|expand|collapse|next|prev|back|forward|mute|unmute|volume|audio|video|file|click|loading|load|submit|send|cancel|ok|yes|no|drag|drop|sort|filter|search|reset|clear|undo|redo|refresh|reload|retry|upload|settings|help|about)$/i;

    // Tier 0/1 run before any DOM guessing — they're authoritative when present.
    // Only trusted for the element-bound case or a single-audio page; on a page
    // listing many files, page-level metadata describes the page, not the file.
    const singleAudio = document.querySelectorAll('audio').length <= 1;
    if (el || singleAudio) {
      const ms = fromMediaSession();
      if (ms && !isSiteName(ms)) return ms;
      const ld = fromJsonLd(url);
      if (ld && !isSiteName(ld)) return ld;
      const md = fromMicrodata(el);
      if (md && !isSiteName(md)) return md;
    }

    function isUsefulTitle(t) {
      if (!t || t.length < 3 || t.length > 120) return false;
      if (t.startsWith('http')) return false;
      // Reject single words (likely icon labels)
      if (!/\s/.test(t) && t.length < 20) return false;
      // Reject known junk
      if (JUNK_TITLES.test(t.trim())) return false;
      return true;
    }

    // 1. Element's own readable text (if it's a link, not just a URL)
    if (el) {
      const text = el.textContent?.trim();
      if (text && text.length > 2 && text.length < 100 && !text.startsWith('http') && !/\s/.test(text) === false) {
        // Multi-word text is good
        if (/\s/.test(text) || text.length > 15) return text;
      }
      // Skip el.title — too often it's "Download" or icon label
      // Only use if it passes strict check
      if (isUsefulTitle(el.title)) return el.title;
      if (isUsefulTitle(el.getAttribute('aria-label'))) return el.getAttribute('aria-label');
    }

    // 2. Look for title in CSS class-named elements and aria-label
    const titleClassSelectors = [
      '[aria-label]',
      '.title', '.track-title', '.audio-title', '.song-title', '.media-title',
      '.post-title', '.entry-title', '.content-title', '.item-title',
      '.name', '.track-name', '.song-name', '.file-name',
      '[class*="title"]', '[class*="Title"]',
      '[class*="track-name"]', '[class*="trackName"]',
      'h1', 'h2', 'h3',
    ];

    // Search from element context first, then page-wide
    if (el) {
      // Check aria-label on the element itself and parents first
      let ariaEl = el;
      for (let d = 0; d < 6 && ariaEl; d++) {
        const al = ariaEl.getAttribute('aria-label');
        if (isUsefulTitle(al)) return al;
        ariaEl = ariaEl.parentElement;
      }

      // Walk up to find a container, then look for title classes inside it
      let parent = el.parentElement;
      for (let depth = 0; depth < 8 && parent; depth++) {
        for (const sel of titleClassSelectors) {
          try {
            const found = parent.querySelector(sel);
            if (found && found !== el) {
              // For aria-label, grab the attribute value
              const al = found.getAttribute('aria-label');
              if (isUsefulTitle(al)) return al;
              // For other elements, grab textContent
              const ft = found.textContent?.trim();
              if (ft && ft.length > 2 && ft.length < 100 && !ft.startsWith('http')) {
                if (/\s/.test(ft) || ft.length > 15) return ft;
              }
            }
          } catch {}
        }
        parent = parent.parentElement;
      }

      // Check previous siblings for descriptive text
      let sibling = el.previousElementSibling;
      for (let i = 0; i < 3 && sibling; i++) {
        const tag = sibling.tagName;
        if (['H1','H2','H3','H4','H5','H6','P','SPAN','LABEL','STRONG','B','EM'].includes(tag)) {
          const st = sibling.textContent?.trim();
          if (st && st.length > 2 && st.length < 100 && !st.startsWith('http') && (/\s/.test(st) || st.length > 15)) return st;
        }
        sibling = sibling.previousElementSibling;
      }

      // Check parent's title/aria-label (with strict filter)
      let p = el.parentElement;
      for (let d = 0; d < 4 && p; d++) {
        if (isUsefulTitle(p.title)) return p.title;
        if (isUsefulTitle(p.getAttribute('aria-label'))) return p.getAttribute('aria-label');
        p = p.parentElement;
      }
    }

    // 3. Page-wide search (for intercepted streams with no element context)
    //    Try to find the audio element by src match, then search near it
    if (!el) {
      // Try to locate the audio element that has this URL
      const allAudio = document.querySelectorAll('audio');
      for (const a of allAudio) {
        const aSrc = a.src || a.querySelector('source')?.src || '';
        if (aSrc === url || url.includes(aSrc) || aSrc.includes(url.split('?')[0])) {
          // Found the element — search near it
          let p = a.parentElement;
          for (let d = 0; d < 8 && p; d++) {
            // Check aria-label
            const al = p.getAttribute('aria-label');
            if (isUsefulTitle(al)) return al;
            // Check title-class elements inside this container
            for (const sel of titleClassSelectors) {
              try {
                const found = p.querySelector(sel);
                if (found && found !== a) {
                  const fal = found.getAttribute('aria-label');
                  if (isUsefulTitle(fal)) return fal;
                  const ft = found.textContent?.trim();
                  if (ft && ft.length > 2 && ft.length < 100 && !ft.startsWith('http') && (/\s/.test(ft) || ft.length > 15)) return ft;
                }
              } catch {}
            }
            p = p.parentElement;
          }
          break;
        }
      }

      // Fallback: page-wide title search (only if single audio on page)
      if (allAudio.length <= 1) {
        for (const sel of titleClassSelectors.slice(0, 10)) {
          try {
            const found = document.querySelector(sel);
            if (found) {
              const fal = found.getAttribute('aria-label');
              if (isUsefulTitle(fal)) return fal;
              const ft = found.textContent?.trim();
              if (ft && ft.length > 2 && ft.length < 100 && !ft.startsWith('http') && (/\s/.test(ft) || ft.length > 15)) return ft;
            }
          } catch {}
        }
      }
    }

    // 4. og:title — used directly now. Previously its mere existence gated
    //    cleanFilename, so og:title was only ever returned when the filename
    //    was unusable, which is backwards. Skipped when it's just the site name.
    const ogTitle = document.querySelector('meta[property="og:title"]')?.content?.trim();
    if (ogTitle && ogTitle.length > 2 && ogTitle.length < 120 && !isSiteName(ogTitle)) {
      const stripped = stripSiteAffix(ogTitle);
      if (stripped.length > 2 && !isSiteName(stripped)) return stripped;
    }

    // 5. Document title — only if it isn't simply the site name, which is the
    //    common case that produced "SoundCloud" as every track's title.
    const docTitle = document.title?.trim();
    if (docTitle && docTitle.length > 2 && !isSiteName(docTitle)) {
      const short = stripSiteAffix(docTitle);
      if (short && short.length > 2 && short.length < 80 && !isSiteName(short)) {
        const cleaned = cleanFilename(url);
        // Pair page title with filename only when they add different info
        if (cleaned && cleaned.length > 2 && normName(cleaned) !== normName(short)) {
          return `${short} — ${cleaned}`;
        }
        return short;
      }
    }

    // 6. Clean the filename itself
    const cleaned = cleanFilename(url);
    if (cleaned && cleaned.length > 2) return cleaned;

    // 7. Last resort
    return decodeURIComponent(url.split('/').pop().split('?')[0]).slice(0, 60) || 'Untitled';
  }

  // ===== PAGE STYLES =====
  const st = document.createElement('style');
  st.textContent = `
@keyframes __afpSlideDown{from{opacity:0;transform:translateX(-50%) translateY(-6px)}to{opacity:1;transform:translateX(-50%) translateY(0)}}
@keyframes __afpToastIn{from{opacity:0;transform:translateX(-50%) translateY(-4px) scale(.97)}to{opacity:1;transform:translateX(-50%) translateY(0) scale(1)}}
@keyframes __afpToastOut{to{opacity:0;transform:translateX(-50%) translateY(-8px) scale(.96)}}

.__afp-pill{position:fixed;top:14px;left:50%;transform:translateX(-50%);z-index:2147483646;display:none;align-items:center;gap:7px;background:rgba(28,28,30,.88);backdrop-filter:blur(40px) saturate(180%);-webkit-backdrop-filter:blur(40px) saturate(180%);border:1px solid rgba(255,255,255,.08);border-radius:22px;padding:7px 12px 7px 13px;font-family:-apple-system,BlinkMacSystemFont,'SF Pro Text','Helvetica Neue',sans-serif;font-size:13px;color:rgba(255,255,255,.85);cursor:pointer;box-shadow:0 2px 20px rgba(0,0,0,.35),0 0 0 .5px rgba(255,255,255,.05);user-select:none;animation:__afpSlideDown .35s ease;transition:background .2s,box-shadow .2s}
.__afp-pill.show{display:flex}
.__afp-pill:hover{background:rgba(44,44,46,.92);box-shadow:0 4px 28px rgba(0,0,0,.45),0 0 0 .5px rgba(255,255,255,.08)}
.__afp-pill-icon{display:flex;align-items:center;color:rgba(255,255,255,.55)}
.__afp-pill-count{background:rgba(10,132,255,.18);color:#5ac8fa;font-weight:600;font-size:11px;padding:1px 7px;border-radius:10px;min-width:20px;text-align:center}
.__afp-pill-arrow{display:flex;align-items:center;color:rgba(255,255,255,.25);transition:transform .25s cubic-bezier(.4,0,.2,1)}
.__afp-pill.open .__afp-pill-arrow{transform:rotate(180deg)}

.__afp-list{position:fixed;top:52px;left:50%;transform:translateX(-50%);z-index:2147483645;width:340px;max-height:380px;background:rgba(28,28,30,.92);backdrop-filter:blur(40px) saturate(180%);-webkit-backdrop-filter:blur(40px) saturate(180%);border:1px solid rgba(255,255,255,.08);border-radius:14px;box-shadow:0 12px 48px rgba(0,0,0,.5),0 0 0 .5px rgba(255,255,255,.04);font-family:-apple-system,BlinkMacSystemFont,'SF Pro Text','Helvetica Neue',sans-serif;overflow:hidden;display:none;animation:__afpSlideDown .2s ease}
.__afp-list.show{display:block}
.__afp-list-hdr{padding:13px 16px 10px;font-size:11px;font-weight:600;letter-spacing:.02em;color:rgba(255,255,255,.35);border-bottom:1px solid rgba(255,255,255,.06);display:flex;justify-content:space-between;align-items:center}
.__afp-list-hdr button{display:flex;align-items:center;gap:4px;background:rgba(10,132,255,.12);border:none;color:#5ac8fa;font-size:11px;font-weight:600;padding:4px 11px;border-radius:8px;cursor:pointer;font-family:inherit;transition:background .15s}
.__afp-list-hdr button:hover{background:rgba(10,132,255,.22)}
.__afp-list-scroll{max-height:320px;overflow-y:auto;overscroll-behavior:contain}
.__afp-list-scroll::-webkit-scrollbar{width:0}
.__afp-item{display:flex;align-items:center;gap:10px;padding:10px 16px;cursor:pointer;border-bottom:1px solid rgba(255,255,255,.03);transition:background .1s;position:relative}
.__afp-item:last-child{border-bottom:none}
.__afp-item:hover{background:rgba(255,255,255,.04)}
.__afp-item-play{width:28px;height:28px;border-radius:50%;flex-shrink:0;background:rgba(10,132,255,.08);display:flex;align-items:center;justify-content:center;color:rgba(10,132,255,.7);transition:all .15s}
.__afp-item:hover .__afp-item-play{background:rgba(10,132,255,.9);color:#fff}
.__afp-item-meta{flex:1;min-width:0}
.__afp-item-name{font-size:13px;font-weight:500;color:rgba(255,255,255,.85);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.__afp-item-type{font-size:10px;font-weight:500;color:rgba(255,255,255,.2);margin-top:1px}
.__afp-item-tip{position:absolute;bottom:calc(100% + 4px);left:12px;right:12px;background:rgba(20,20,22,.97);border:1px solid rgba(255,255,255,.08);border-radius:8px;padding:8px 10px;font-size:10px;color:rgba(255,255,255,.4);font-family:'SF Mono',Menlo,monospace;word-break:break-all;line-height:1.5;box-shadow:0 4px 20px rgba(0,0,0,.5);pointer-events:none;opacity:0;transition:opacity .15s;z-index:10}
.__afp-item:hover .__afp-item-tip{opacity:1}
.__afp-empty{padding:24px;text-align:center;font-size:13px;color:rgba(255,255,255,.15);line-height:1.7}

.__afp-toast{position:fixed;top:52px;left:50%;transform:translateX(-50%);z-index:2147483647;background:rgba(28,28,30,.92);backdrop-filter:blur(30px);-webkit-backdrop-filter:blur(30px);border:1px solid rgba(255,255,255,.06);border-radius:10px;padding:8px 14px;font-family:-apple-system,BlinkMacSystemFont,'SF Pro Text',sans-serif;font-size:12px;color:rgba(255,255,255,.65);display:flex;align-items:center;gap:7px;box-shadow:0 4px 20px rgba(0,0,0,.35);white-space:nowrap;animation:__afpToastIn .25s ease,__afpToastOut .3s ease ${TOAST_MS-300}ms forwards;pointer-events:none}
.__afp-toast-icon{display:flex;align-items:center;color:#5ac8fa}
  `;
  document.head.appendChild(st);

  // ===== TOASTS =====
  function toast(text, icon) {
    const t = document.createElement('div');
    t.className = '__afp-toast';
    t.innerHTML = `<span class="__afp-toast-icon">${icon || I.check}</span>${esc(text)}`;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), TOAST_MS + 100);
  }



  /* ===== SEND TRACK =====
     Delivery is postMessage straight to the player window. It crosses origins
     for free, with no permissions and no partitioning.

     The previous version routed adds through a hidden same-origin iframe into
     localStorage. That cannot work: Chrome partitions storage for third-party
     frames by (top-level site, frame site), so the iframe wrote to
     (their-site -> our-origin) while the player window read
     (our-origin -> our-origin). Two buckets, never shared. The bridge reported
     'added' truthfully and the player never saw a thing.

     Storage still persists the queue, but only INSIDE the player window, where
     every instance is top-level on one origin and partitioning never applies.

     Reclaiming the window across navigations is the other half. A reference
     dies with the page, so we ask for the window BY NAME with an empty URL —
     window.open('', name) hands back an existing window WITHOUT navigating it.
     Ping it: a pong means the player is already there and we just send. No
     pong means we got a fresh blank window, so we load the player into it. */

  const PLAYER_WINDOW_NAME = '__afp_player';
  const PONG_WAIT = 400;

  let playerReady = false;
  let pending = [];

  W.addEventListener('message', e => {
    if (e.origin !== PLAYER_ORIGIN) return;
    const d = e.data;
    if (!d || typeof d !== 'object' || d.__afp !== 1) return;
    // 'ready' = the window just loaded. 'pong' = a window we reclaimed is alive.
    if (d.type === 'ready' || d.type === 'pong') { playerReady = true; flushPending(); return; }
    if (d.type === 'added') {
      pending = [];
      if (d.count > 0) toast(d.count > 1 ? ('Added ' + d.count + ' tracks') : 'Added to queue', I.music);
      else toast('Already in queue', I.check);      // never silent
    }
  });

  function flushPending() {
    if (!playerReady || !pending.length) return;
    if (!popup || popup.closed) { playerReady = false; return; }
    const tracks = pending;
    pending = [];
    try { popup.postMessage({ __afp: 1, type: 'addMany', tracks }, PLAYER_ORIGIN); }
    catch (_) { pending = tracks; }                 // keep them for the next attempt
  }

  function popupFeatures() {
    const left = W.screenX + W.innerWidth - POPUP_W - 40, top = W.screenY + 60;
    return 'popup=yes,width=' + POPUP_W + ',height=' + POPUP_H + ',left=' + left + ',top=' + top
         + ',resizable=yes,scrollbars=no,menubar=no,toolbar=no,location=no,status=no';
  }

  function sendToPlayer(url, title, site) {
    pending.push({ url, title, site: site || pageSite() });

    // Live and handshaken already — nothing to do but send.
    if (popup && !popup.closed && playerReady) { flushPending(); return; }

    // Empty URL: hands back a window already using this name WITHOUT reloading
    // it, or a fresh blank one. Must run inside the click for the popup blocker.
    if (!popup || popup.closed) {
      playerReady = false;
      try { popup = W.open('', PLAYER_WINDOW_NAME, popupFeatures()); } catch (_) { popup = null; }
    }
    if (!popup) {
      toast('Popup blocked — allow popups for this site', I.ext);
      pending = [];
      return;
    }

    let ponged = false;
    const onPong = e => {
      if (e.origin !== PLAYER_ORIGIN) return;
      const d = e.data;
      if (d && d.__afp === 1 && (d.type === 'pong' || d.type === 'ready')) ponged = true;
    };
    W.addEventListener('message', onPong);
    try { popup.postMessage({ __afp: 1, type: 'ping' }, PLAYER_ORIGIN); } catch (_) {}

    setTimeout(() => {
      W.removeEventListener('message', onPong);
      if (ponged || playerReady) return;            // the main handler flushed already
      // No answer: it's a blank window, so load the player into it. Navigating a
      // window we already own is not a new popup, so this isn't blocked.
      try { popup.location.href = PLAYER_URL; }
      catch (_) {
        try { popup = W.open(PLAYER_URL, PLAYER_WINDOW_NAME, popupFeatures()); } catch (_) {}
      }
      // Its 'ready' announcement triggers the flush.
    }, PONG_WAIT);
  }

  // Explicit "open the player" action — same reclaim, no track attached.
  function openPlayerWindow() {
    if (popup && !popup.closed) { try { popup.focus(); } catch (_) {} return; }
    try { popup = W.open(PLAYER_URL, PLAYER_WINDOW_NAME, popupFeatures()); } catch (_) { popup = null; }
    if (!popup) { toast('Popup blocked — allow popups for this site', I.ext); return; }
    playerReady = false;
    toast('Player opened', I.ext);
  }

  // ===== PILL & LIST =====
  function createPill(){
    if(pill)return;
    pill=document.createElement('div');pill.className='__afp-pill';
    pill.innerHTML=`<span class="__afp-pill-icon">${I.music}</span><span style="font-weight:500">Audio</span><span class="__afp-pill-count" id="__afp-c">0</span><span class="__afp-pill-arrow">${I.chev}</span>`;
    pill.addEventListener('click',toggleList);document.body.appendChild(pill);

    listPanel=document.createElement('div');listPanel.className='__afp-list';
    listPanel.innerHTML=`<div class="__afp-list-hdr"><span>Sources</span><span style="display:flex;gap:6px"><button id="__afp-open">${I.ext} Player</button><button id="__afp-pa">${I.play} Add all</button></span></div><div class="__afp-list-scroll" id="__afp-sc"></div>`;
    document.body.appendChild(listPanel);
    document.getElementById('__afp-pa').addEventListener('click',()=>{sources.forEach(s=>sendToPlayer(s.url,s.title,s.site));closeList()});
    // The only path that opens a window — everything else adds silently.
    document.getElementById('__afp-open').addEventListener('click',()=>{openPlayerWindow();closeList()});
    document.addEventListener('click',e=>{if(!listOpen)return;if(e.target.closest('.__afp-pill')||e.target.closest('.__afp-list'))return;closeList()});
  }
  function toggleList(){listOpen?closeList():openList()}
  function openList(){listOpen=true;pill.classList.add('open');renderSrc();listPanel.classList.add('show')}
  function closeList(){listOpen=false;pill.classList.remove('open');listPanel.classList.remove('show')}
  function updatePill(){if(!pill)createPill();document.getElementById('__afp-c').textContent=sources.length;pill.classList.toggle('show',sources.length>0)}

  function renderSrc(){
    const sc=document.getElementById('__afp-sc');if(!sc)return;
    if(!sources.length){sc.innerHTML='<div class="__afp-empty">No audio detected<br><br>Ctrl+Shift+P to add any URL</div>';return}
    sc.innerHTML='';
    sources.forEach(s=>{
      const d=document.createElement('div');d.className='__afp-item';
      const ext=s.url.split('?')[0].split('.').pop().substring(0,4).toUpperCase();
      d.innerHTML=`<div class="__afp-item-play">${I.play}</div><div class="__afp-item-meta"><div class="__afp-item-name">${esc(s.title)}</div><div class="__afp-item-type">${ext}</div></div><div class="__afp-item-tip">${esc(s.url)}</div>`;
      d.addEventListener('click',()=>{sendToPlayer(s.url,s.title,s.site);closeList()});
      sc.appendChild(d);
    });
  }

  // ===== SCAN =====
  // Returns true only when the URL was genuinely new, so callers can avoid
  // re-toasting audio we already know about.
  function addSource(u,t,type){
    if(sourceUrls.has(u))return false;
    sourceUrls.add(u);sources.push({url:u,title:t,type,site:pageSite()});updatePill();if(listOpen)renderSrc();
    refineWithID3(u);            // async; upgrades the title in place if tags exist
    return true;
  }

  /* ===== ID3 TITLE REFINEMENT =====
     extractName is synchronous and returns its best DOM-derived guess straight
     away, so the UI never waits. Reading the file's own tags requires network,
     so it runs afterwards and upgrades the title in place when it finds
     something better — in the pill list AND in any open player window.

     GM_xmlhttpRequest is what makes this viable: a plain fetch is subject to
     CORS, and most audio CDNs don't grant it, so tag reading would fail on
     exactly the files we care about. */

  const ID3_MAX_CONCURRENT = 2;
  const id3Done = new Set();
  const id3Queue = [];
  let id3Active = 0;

  /* Range-fetch transport is resolved once at startup, because this script runs
     in three different environments and each has a different CORS escape hatch:

       Tampermonkey   GM_xmlhttpRequest      ignores CORS outright
       Extension      background worker      not CORS-bound, needs host_permissions
       Bare page      fetch                  CORS applies; most audio CDNs refuse

     Everything degrades to "no ID3, DOM title only" rather than breaking. */

  // Extension path: content scripts ARE CORS-bound, so the fetch has to happen
  // in the service worker. See the companion snippet in the deploy notes.
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

  // Last resort. Works only where the host sends permissive CORS headers.
  async function plainRange(url, start, end) {
    try {
      const res = await fetch(url, { headers: { Range: `bytes=${start}-${end}` }, mode: 'cors' });
      if (!res.ok) return null;
      return new Uint8Array(await res.arrayBuffer());
    } catch (_) { return null; }
  }

  /* MAIN-world path. The interceptors require MAIN world, but chrome.runtime is
     only exposed to the ISOLATED world — so a MAIN-world script cannot reach the
     background worker directly. A tiny isolated relay content script bridges the
     two over postMessage (see EXTENSION-SETUP.md). If no relay answers within
     the timeout we fall back to plain fetch rather than hanging. */
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

  /* Host-supplied transport takes priority over everything else.
     If your extension already has a privileged fetch helper (an http()/gmFetch()
     that round-trips through your own bridge to the service worker), expose it as:

         AFP_RANGE_FETCH = (url, start, end) => Promise<Uint8Array|null>;

     …and the player uses it verbatim. Resolve null on any failure — never throw.
     This avoids duplicating a second bridge alongside one that already works. */
  function pickRangeFetcher() {
    if (typeof AFP_RANGE_FETCH === 'function') return AFP_RANGE_FETCH;         // host-provided
    if (typeof GM_xmlhttpRequest === 'function') return gmRange;               // Tampermonkey
    if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage)
      return bgRange;                                                          // isolated content script
    if (typeof AFP_USE_BRIDGE !== 'undefined' && AFP_USE_BRIDGE) return bridgeRange; // MAIN world + my relay
    // Last resort. Measured as BLOCKED for ranged audio in a CORS-bound world,
    // so it will not produce tags there — kept only for permissive hosts.
    if (typeof fetch === 'function') return plainRange;
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
            // 206 = server honoured the Range. A 200 means it ignored it and
            // sent the whole file; still parseable, just wasteful, so we accept
            // it for the small header read and bail on the larger body read.
            if (r.status !== 206 && r.status !== 200) return done(null);
            done(r.response ? new Uint8Array(r.response) : null);
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
      // AFPID3 arrives via @require (Tampermonkey) or as a separate file listed
      // before this one in the extension's content_scripts array.
      const ID3 = (typeof AFPID3 !== 'undefined') ? AFPID3
                : (typeof W !== 'undefined' && W.AFPID3) ? W.AFPID3 : null;
      if (!ID3 || !rangeFetcher) return;
      const tags = await ID3.readTags(url, rangeFetcher);
      const better = ID3.formatTitle(tags);
      if (!better) return;

      const src = sources.find(s => s.url === url);
      // Only replace a filename-ish guess; never override a real page title
      // that's already longer and more descriptive than the tag.
      if (src && better.length > 2 && better !== src.title) {
        src.title = better;
        if (listOpen) renderSrc();
        // Rename it in the player window if one is open and handshaken.
        if (popup && !popup.closed && playerReady) {
          try { popup.postMessage({ __afp: 1, type: 'retitle', url, title: better }, PLAYER_ORIGIN); } catch (_) {}
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

  // Every branch checks sourceUrls BEFORE calling extractName. Arguments
  // evaluate before the call, so doing it the other way round ran the full
  // ancestor walk (~8 levels x ~20 selectors) for every already-known track on
  // every scan — every 3s plus on every DOM mutation — and threw it all away.
  function scan(){
    document.querySelectorAll('a[href]').forEach(a=>{
      const u=a.href;
      if(!isAudioUrl(u)||sourceUrls.has(u))return;
      addSource(u,extractName(u,a),u.split('?')[0].split('.').pop().toUpperCase());
    });
    document.querySelectorAll('audio').forEach(el=>{
      const s=el.src||el.querySelector('source')?.src;
      if(!s||!s.startsWith('http')||sourceUrls.has(s))return;
      addSource(s,extractName(s,el),'AUDIO');
    });
    document.querySelectorAll('source[type^="audio"]').forEach(el=>{
      const s=el.src;
      if(!s||sourceUrls.has(s))return;
      addSource(s,extractName(s,el.closest('audio')||el),el.type);
    });
  }

  /* Discoveries reported by afp-intercept.js running in the MAIN world.
     Isolated worlds share the window's message target, so a postMessage from
     MAIN is received here even though the two can't see each other's globals.
     This is the only path by which dynamically-created audio reaches the player
     when we're not in MAIN ourselves. */
  W.addEventListener('message', e => {
    const d = e.data;
    if (!d || d.__afpFound !== 1 || typeof d.url !== 'string') return;
    if (!/^https?:\/\//i.test(d.url) || sourceUrls.has(d.url)) return;
    const title = extractName(d.url, null);
    if (addSource(d.url, title, typeof d.source === 'string' ? d.source : 'STREAM')) {
      toast('Audio detected: ' + (title.length > 30 ? title.substring(0, 27) + '...' : title), I.music);
    }
  });

  /* In page context (Tampermonkey, or this file loaded directly into MAIN) the
     patches work right here, so skip the shim round-trip entirely. In an
     isolated world they'd be inert, and the 'intercept' copy reports instead. */
  if (IN_MAIN_WORLD) installInterceptors(interceptedAudio);

  // ===== DEEP INTERCEPTORS =====
  // Catch audio that sites create dynamically via JS — no DOM links to find

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
        && !/\.(html?|php|aspx?|[cm]?jsx?|css|json|xml|png|jpe?g|gif|svg|webp|ico|woff2?|ttf)$/.test(clean)) return true;

    if (/[?&](ct|content.?type|type)=audio/.test(path)) return true;
    return false;
  }

  // `trusted` = the response content-type already confirmed audio, so the URL
  // heuristic is skipped. That's the opaque-URL case (/api/v2/media/8f3a91)
  // that sniffing structurally cannot catch.
  function interceptedAudio(url, source, el, trusted) {
    if (!url || typeof url !== 'string' || !/^https?:\/\//i.test(url)) return;
    if (!trusted && !looksLikeAudio(url)) return;
    if (sourceUrls.has(url)) return;          // bail before the costly extractName
    // If no element passed, try to find the audio element that has this src
    if (!el) {
      try {
        el = document.querySelector(`audio[src="${CSS.escape(url)}"], audio source[src="${CSS.escape(url)}"]`);
        if (el?.tagName === 'SOURCE') el = el.closest('audio');
      } catch (_) {}
    }
    const title = extractName(url, el);
    // Toast only on genuinely new audio. Range requests re-fetch the same file
    // continuously during playback, which used to spam a toast every time.
    if (addSource(url, title, source)) {
      toast('Audio detected: ' + (title.length > 30 ? title.substring(0, 27) + '...' : title), I.music);
    }
  }

  /* Patches 1-4 only function in the page world. In an isolated world they
     patch objects the page never sees, so we skip them entirely and let
     afp-intercept.js (registered with world:'MAIN') do the interception and
     postMessage its findings to the __afpFound handler above. */
  /* The four page-global patches, installed only where they can actually work.
     Takes a sink so the same code serves both roles: the MAIN-world copy
     postMessages its findings, the page-context copy (Tampermonkey) handles
     them inline. */
  function installInterceptors(report) {

    // 1. Patch HTMLMediaElement.prototype.src setter
    //    Catches: el.src = "https://stream.example.com/..."
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

    // 2. Patch window.Audio constructor
    //    Catches: new Audio("https://stream.example.com/...")
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

    // 3. Patch fetch — catch responses with audio content-type
    try {
      const _fetch = W.fetch;
      W.fetch = async function(...args) {
        const res = await _fetch.apply(this, args);
        try {
          if (res.ok) {
            const ct = (res.headers.get('content-type') || '').toLowerCase();
            const raw = typeof args[0] === 'string' ? args[0] : args[0]?.url || '';
            const url = raw ? new URL(raw, location.href).href : '';
            // content-type is authoritative here, so mark it trusted — otherwise
            // interceptedAudio re-tested the URL and threw away the very cases
            // this interceptor exists to catch.
            if (ct.includes('audio') || ct.includes('mpeg') || ct.includes('ogg')) {
              report(url, 'FETCH', null, true);
            }
          }
        } catch (e) {}
        return res;
      };
    } catch (e) {}

    // 4. Patch XHR — catch audio requests
    try {
      const _open = W.XMLHttpRequest.prototype.open;
      W.XMLHttpRequest.prototype.open = function(method, url, ...rest) {
        try {
          if (typeof url === 'string') {
            const abs = new URL(url, location.href).href;
            if (/^https?:/i.test(abs)) {
              // Detect on completion rather than on open(): firing here meant
              // 404s, aborted requests and failed loads all entered the queue.
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


  // 5. Watch for <audio>/<source> elements added to DOM
  new MutationObserver(muts => {
    for (const m of muts) {
      m.addedNodes.forEach(n => {
        if (!n.tagName) return;
        if (n.tagName === 'AUDIO') {
          const src = n.src || n.querySelector?.('source')?.src;
          if (src && src.startsWith('http')) interceptedAudio(src, 'DOM', n);
          // Also watch for .src being set later on this specific element
          const check = () => { if (n.src && n.src.startsWith('http')) interceptedAudio(n.src, 'DOM', n); };
          n.addEventListener('loadstart', check, { once: true });
        }
        if (n.tagName === 'SOURCE') {
          const src = n.src || n.getAttribute('src');
          if (src && src.startsWith('http')) interceptedAudio(src, 'DOM', n.closest('audio') || n);
        }
      });
    }
  }).observe(document, { childList: true, subtree: true });

  // ===== KEYBOARD =====
  document.addEventListener('keydown',e=>{
    if(e.target.tagName==='INPUT'||e.target.tagName==='TEXTAREA'||e.target.isContentEditable)return;
    if(e.ctrlKey&&e.shiftKey&&(e.key==='p'||e.key==='P')){
      e.preventDefault();
      const sel=window.getSelection()?.toString().trim();
      if(sel&&(sel.startsWith('http')||sel.startsWith('//'))){sendToPlayer(sel,extractName(sel,null));return}
      navigator.clipboard.readText().then(t=>{t=t?.trim();if(t&&(t.startsWith('http')||t.startsWith('//'))){sendToPlayer(t,extractName(t,null))}else{const u=prompt('Audio URL:');if(u?.trim())sendToPlayer(u.trim(),extractName(u.trim(),null))}}).catch(()=>{const u=prompt('Audio URL:');if(u?.trim())sendToPlayer(u.trim(),extractName(u.trim(),null))});
    }
  });

  setTimeout(scan,800);setTimeout(scan,2500);setInterval(scan,SCAN_INTERVAL);
  const obs=new MutationObserver(()=>{clearTimeout(obs._t);obs._t=setTimeout(scan,300)});
  obs.observe(document.body,{childList:true,subtree:true});
})();
