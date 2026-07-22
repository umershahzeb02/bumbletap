# One player across all sites — extension setup

Paste these three things into your extension. Nothing else is required.

## 1. New file: `afp-queue-relay.js`

```js
// ISOLATED world, matches *://*/* — must also cover the player page.
window.addEventListener('message', e => {
  const d = e.data;
  if (e.source !== window || !d || d.__afp !== 1 || d.reply) return;
  if (!['ext-queue-get','ext-queue-add','ext-queue-set','ext-player-open'].includes(d.type)) return;

  chrome.runtime.sendMessage({ type: 'afp-queue', op: d.type, payload: d }, r => {
    window.postMessage({
      __afp: 1, reply: true, id: d.id, type: d.type + '-result',
      ok: !chrome.runtime.lastError && r && r.ok,
      queue: r && r.queue ? r.queue : null,
      count: r && typeof r.count === 'number' ? r.count : 0,
      total: r && typeof r.total === 'number' ? r.total : 0,
      open:  !!(r && r.open)
    }, '*');
  });
});

// Worker pushes changes; forward into the page world.
chrome.runtime.onMessage.addListener(msg => {
  if (msg && msg.type === 'afp-queue-changed') {
    window.postMessage({ __afp: 1, reply: true, type: 'ext-queue-changed', queue: msg.queue }, '*');
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

## 3. manifest.json

```jsonc
"permissions": ["userScripts", "storage", "tabs"],
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
