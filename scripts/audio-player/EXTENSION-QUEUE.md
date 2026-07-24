# One player across all sites — extension setup

Paste these three things into your extension. Nothing else is required.

## 1. New file: `afp-queue-relay.js`

```js
// ISOLATED world, matches *://*/* — must also cover the player page.
window.addEventListener('message', e => {
  const d = e.data;
  if (e.source !== window || !d || d.__afp !== 1 || d.reply) return;
  if (!['ext-queue-get','ext-queue-add','ext-queue-set','ext-player-open','ext-authorize'].includes(d.type)) return;

  chrome.runtime.sendMessage({ type: 'afp-queue', op: d.type, payload: d }, r => {
    window.postMessage({
      __afp: 1, reply: true, id: d.id, type: d.type + '-result',
      ok: !chrome.runtime.lastError && r && r.ok,
      queue: r && r.queue ? r.queue : null,
      count: r && typeof r.count === 'number' ? r.count : 0,
      total: r && typeof r.total === 'number' ? r.total : 0,
      open:  !!(r && r.open),
      authorized: !!(r && r.authorized)
    }, '*');
  });
});

// Worker pushes changes; forward into the page world.
chrome.runtime.onMessage.addListener(msg => {
  if (msg && msg.type === 'afp-queue-changed') {
    window.postMessage({ __afp: 1, reply: true, type: 'ext-queue-changed', queue: msg.queue }, '*');
  }
  // Whether a player window exists anywhere. Pages cache this to decide, without
  // blocking, whether a click needs to open one — a stale answer is what makes a
  // window flash open and immediately close again.
  if (msg && msg.type === 'afp-player-state') {
    window.postMessage({ __afp: 1, reply: true, type: 'ext-player-state', open: !!msg.open }, '*');
  }
});
```

## 2. Append to `background.js`

```js
const AFP_KEY = 'afp_queue_v1';
const AFP_PLAYER_URL = 'https://umershahzeb02.github.io/bumbletap/scripts/audio-player/player.html';

const afpLoad = async () => {
  const r = await chrome.storage.local.get(AFP_KEY);
  const v = r[AFP_KEY];
  return (v && Array.isArray(v.queue)) ? v : { queue: [], idx: -1 };
};
const afpSave = v => chrome.storage.local.set({ [AFP_KEY]: v });
const afpValid = t => t && typeof t.url === 'string' && /^https?:\/\//i.test(t.url);

async function afpBroadcast(queue) {
  const tabs = await chrome.tabs.query({});
  for (const t of tabs) {
    chrome.tabs.sendMessage(t.id, { type: 'afp-queue-changed', queue }).catch(() => {});
  }
}

/* Tell every page whether a player window exists, whenever that changes.

   Pages cannot see across tabs, so each one caches this answer and consults the
   cache synchronously on click — a popup may only be opened while the click is
   still user-activated, so there is no time to ask. Asking only at page load
   left the cache stale: a player opened later, from another tab, stayed
   invisible, and the next add opened a throwaway window that lost the singleton
   election and closed itself. That is the window that flashes. */
let afpStateTimer = null;
async function afpPlayerState() {
  const players = await chrome.tabs.query({ url: AFP_PLAYER_URL + '*' });
  const open = players.length > 0;
  const tabs = await chrome.tabs.query({});
  for (const t of tabs) {
    chrome.tabs.sendMessage(t.id, { type: 'afp-player-state', open }).catch(() => {});
  }
}
// Tab events fire in bursts; collapse them so one settled answer goes out.
function afpPlayerStateSoon() {
  clearTimeout(afpStateTimer);
  afpStateTimer = setTimeout(() => { afpPlayerState(); }, 150);
}
chrome.tabs.onCreated.addListener(afpPlayerStateSoon);
chrome.tabs.onRemoved.addListener(afpPlayerStateSoon);
chrome.tabs.onUpdated.addListener((id, info) => {
  if (info.status === 'complete' || info.url) afpPlayerStateSoon();
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.type !== 'afp-queue') return;
  (async () => {
    const state = await afpLoad();

    if (msg.op === 'ext-queue-get') {
      sendResponse({ ok: true, queue: state.queue, total: state.queue.length });

    } else if (msg.op === 'ext-player-open') {
      // Definitive: does a tab currently have the player loaded?
      const tabs = await chrome.tabs.query({ url: AFP_PLAYER_URL + '*' });
      sendResponse({ ok: true, open: tabs.length > 0 });

    } else if (msg.op === 'ext-queue-add') {
      const tracks = Array.isArray(msg.payload.tracks) ? msg.payload.tracks : [];
      let count = 0;
      for (const t of tracks) {
        if (!afpValid(t)) continue;
        if (state.queue.some(x => x.url === t.url)) continue;
        state.queue.push({
          url: t.url,
          title: typeof t.title === 'string' && t.title ? t.title : t.url.split('/').pop(),
          site: typeof t.site === 'string' ? t.site : null
        });
        count++;
      }
      if (count) { await afpSave(state); afpBroadcast(state.queue); }
      sendResponse({ ok: true, count, total: state.queue.length });

    } else if (msg.op === 'ext-authorize') {
      const ok = await afpAuthorize(msg.payload.url, msg.payload.site);
      sendResponse({ ok: true, authorized: ok });

    } else if (msg.op === 'ext-queue-set') {
      const q = Array.isArray(msg.payload.queue) ? msg.payload.queue.filter(afpValid) : [];
      state.queue = q;
      if (typeof msg.payload.idx === 'number') state.idx = msg.payload.idx;
      await afpSave(state);
      afpBroadcast(state.queue);
      sendResponse({ ok: true, total: q.length });

    } else {
      sendResponse({ ok: false });
    }
  })();
  return true;
});
```

## 3. Also append to `background.js` — site-locked streams

Some hosts serve audio only to requests carrying a session cookie for the site
the track came from. `stream.audiochan.com` is one: the cookie is same-site on
an audiochan page and third-party in the player, so Chrome drops it and the
media 403s. The track plays on its own site and nowhere else.

The extension is the only party that can still present it. Replaying the cookie
is legitimate — it goes to the host that issued it and nowhere else, and the
rule is scoped by target URL so nothing else on the web sees it.

```js
const AFP_RULE_BASE = 9000;
const afpAuthorized = new Map();          // media host -> dynamic rule id

// Good enough for the hosts this handles. Not PSL-accurate, so a .co.uk style
// domain matches more broadly than ideal — cookies still only ever travel to
// the host that set them, so the blast radius is unchanged.
const afpRegistrable = h => {
  const p = String(h).replace(/^www\./, '').split('.');
  return p.length > 2 ? p.slice(-2).join('.') : p.join('.');
};

async function afpAuthorize(mediaUrl, siteHint) {
  let host;
  try { host = new URL(mediaUrl).hostname; } catch (_) { return false; }
  if (afpAuthorized.has(host)) return true;          // rule already installed

  /* Two domains matter and they are usually different: the media host
     (stream.example.com) and the page the track was grabbed from
     (example.com). It is the page's session that authorizes the stream. */
  const domains = new Set([afpRegistrable(host)]);
  if (siteHint) domains.add(afpRegistrable(siteHint));

  const jar = [];
  for (const d of domains) {
    try { jar.push(...await chrome.cookies.getAll({ domain: d })); } catch (_) {}
  }
  if (!jar.length) return false;

  // One value per name; the most specific domain wins.
  const byName = new Map();
  for (const c of jar.sort((a, b) => a.domain.length - b.domain.length)) byName.set(c.name, c);
  const value = [...byName.values()].map(c => c.name + '=' + c.value).join('; ');
  if (!value) return false;

  const id = AFP_RULE_BASE + afpAuthorized.size;
  try {
    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: [id],
      addRules: [{
        id, priority: 1,
        condition: { urlFilter: '||' + host + '/', resourceTypes: ['media', 'xmlhttprequest'] },
        action: { type: 'modifyHeaders',
                  requestHeaders: [{ header: 'cookie', operation: 'set', value }] }
      }]
    });
  } catch (e) {
    // Chrome may refuse to let an extension set the Cookie header at all. If so
    // this is where you find out — the player falls back to reporting the track
    // as site-locked rather than pretending it worked.
    console.warn('[AFP] cookie rule rejected:', e && e.message);
    return false;
  }
  afpAuthorized.set(host, id);
  console.info('[AFP] authorized', host, 'with', byName.size, 'cookies');
  return true;
}
```

## 4. manifest.json

```jsonc
"permissions": [
  "userScripts", "storage", "tabs",
  "cookies", "declarativeNetRequestWithHostAccess"
],
"host_permissions": ["*://*/*"],
"content_scripts": [
  { "matches": ["*://*/*"], "world": "ISOLATED",
    "run_at": "document_idle", "js": ["afp-queue-relay.js"] }
]
```

---

Reload the extension, re-paste `audio-float-player.js` once. Done.

## Without the extension

The relay is an upgrade, not a requirement. With no extension answering:

- the **page** delivers each track straight to the player window over
  `postMessage`, buffered until the window handshakes back;
- the **player** persists to `localStorage` instead of `chrome.storage`.

What you lose is only the cross-site part — the queue becomes per-origin, and it
is not shared with a player window opened from a different site.

Both paths run whenever both are available; `addTrack()` dedupes by URL, so a
track arriving twice is a no-op.
