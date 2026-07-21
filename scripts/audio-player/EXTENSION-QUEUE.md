# Extension-owned queue — the fix for storage partitioning

## Why the iframe approach cannot work

Chrome partitions `localStorage` and `BroadcastChannel` for third-party frames,
keyed by **(top-level site, frame site)**.

```
queue-bridge.html inside example.com   →  partition (example.com → github.io)
player.html opened as a top-level tab  →  partition (github.io  → github.io)
```

Two different buckets. The bridge writes honestly and reports `total: N`; the
player reads a bucket that never receives any of it.

Observed in the wild: deleting three tracks in the player left the bridge's copy
intact, so re-adding one of them came back `count: 0` (deduped against a store
the user could not see), while adding the same URL manually inside the player
worked and reported `1`.

`document.requestStorageAccess()` could lift the partition, but it needs a user
gesture and a browser prompt per site. Not viable for this.

## The fix

`chrome.storage` is **not** partitioned, and the extension's content script
already matches `*://*/*` — which includes the player page itself. So the
extension owns the queue and both ends talk to it:

```
page (USER_SCRIPT)  ──window msg──▶  content script  ──▶  service worker
                                                          chrome.storage.local
                                                                 │
player.html (github.io)  ◀──window msg──  content script  ◀──────┘
```

No iframe, no partitioning, no CSP `frame-src` exposure, no cross-origin
handshake. The player falls back to `localStorage` when no extension answers,
so it still works standalone under Tampermonkey or opened directly.

---

## 1. content script (ISOLATED world, `matches: ["*://*/*"]`)

Relays between page-world messages and the worker. This must run on **every**
site *and* on the player page — one script covers both.

```js
// afp-queue-relay.js  — ISOLATED world
window.addEventListener('message', e => {
  const d = e.data;
  if (e.source !== window || !d || d.__afp !== 1 || d.reply) return;
  if (d.type !== 'ext-queue-get' && d.type !== 'ext-queue-add' &&
      d.type !== 'ext-queue-set') return;

  chrome.runtime.sendMessage({ type: 'afp-queue', op: d.type, payload: d }, r => {
    window.postMessage({
      __afp: 1, reply: true, id: d.id,
      type: d.type + '-result',
      ok: !chrome.runtime.lastError && r && r.ok,
      queue: r && r.queue ? r.queue : null,
      count: r && typeof r.count === 'number' ? r.count : 0,
      total: r && typeof r.total === 'number' ? r.total : 0
    }, '*');
  });
});

// Worker pushes changes to every tab; forward them into the page world so an
// open player updates live.
chrome.runtime.onMessage.addListener(msg => {
  if (msg && msg.type === 'afp-queue-changed') {
    window.postMessage({ __afp: 1, reply: true, type: 'ext-queue-changed',
                         queue: msg.queue }, '*');
  }
});
```

## 2. service worker — append to `background.js`

```js
const AFP_KEY = 'afp_queue_v1';

const afpLoad = async () => {
  const r = await chrome.storage.local.get(AFP_KEY);
  const v = r[AFP_KEY];
  return (v && Array.isArray(v.queue)) ? v : { queue: [], idx: -1 };
};
const afpSave = v => chrome.storage.local.set({ [AFP_KEY]: v });

// Tell every tab, so an open player re-renders immediately.
async function afpBroadcast(queue) {
  const tabs = await chrome.tabs.query({});
  for (const t of tabs) {
    chrome.tabs.sendMessage(t.id, { type: 'afp-queue-changed', queue }).catch(() => {});
  }
}

const afpValid = t => t && typeof t.url === 'string' && /^https?:\/\//i.test(t.url);

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.type !== 'afp-queue') return;
  (async () => {
    const state = await afpLoad();

    if (msg.op === 'ext-queue-get') {
      sendResponse({ ok: true, queue: state.queue, total: state.queue.length });
      return;
    }

    if (msg.op === 'ext-queue-add') {
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
      return;
    }

    if (msg.op === 'ext-queue-set') {
      // Player is authoritative here — reorder, remove, clear, retitle.
      const q = Array.isArray(msg.payload.queue) ? msg.payload.queue.filter(afpValid) : [];
      state.queue = q;
      if (typeof msg.payload.idx === 'number') state.idx = msg.payload.idx;
      await afpSave(state);
      afpBroadcast(state.queue);
      sendResponse({ ok: true, total: q.length });
      return;
    }

    sendResponse({ ok: false });
  })();
  return true;                 // async response
});
```

`chrome.tabs` needs the `tabs` permission (or just `host_permissions`, which you
already have — `chrome.tabs.sendMessage` works with host access).

## 3. manifest additions

```jsonc
"permissions": ["userScripts", "storage", "tabs"],
"content_scripts": [
  { "matches": ["*://*/*"], "world": "ISOLATED",
    "run_at": "document_idle", "js": ["afp-queue-relay.js"] }
]
```

The relay **must** also match the player page (`umershahzeb02.github.io`), which
`*://*/*` covers.

---

## 4. Migrating the three tracks you already have

They're sitting in the player's own `localStorage`. Once the extension path is
live, run this **in the player window** to push them into extension storage:

```js
const q = JSON.parse(localStorage.getItem('__afp_queue_v1') || 'null');
if (q && q.queue) window.postMessage({ __afp: 1, type: 'ext-queue-set', queue: q.queue, idx: q.idx }, '*');
```

## What to expect afterwards

- Adding from the pill on any site writes to `chrome.storage.local`
- An open player updates live via the worker's broadcast
- Closing and reopening the player restores the same queue
- Deleting in the player actually deletes — there is no second hidden copy
