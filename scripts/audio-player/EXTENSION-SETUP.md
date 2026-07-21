# Wiring privileged range-fetch into your extension

> ## MEASURED — this setup is settled, not hypothetical
>
> | Probe | Result | Means |
> |---|---|---|
> | `example.com` ranged read via `http()` | `10B [<!d]` | privileged fetch works, Range honoured |
> | real audio host ranged read | `10B [ID3]` | ID3 pipeline viable end to end |
> | world sentinel | `ISOLATED/USER_SCRIPT` | the 4 prototype patches are inert here |
>
> **Therefore: Path A + the MAIN-world shim.**
> 1. `AFP_RANGE_FETCH = probe` in the custom code (your `http()` helper already
>    matches the contract exactly).
> 2. Register `afp-intercept.js` in the MAIN world at `document_start` — it is
>    the only way dynamically-created audio can be seen.
>
> Sections 3B (my postMessage relay) and 4 below are then unnecessary; the
> player detects its own world at runtime and skips the dead patches.


Measured in the target world: `example.com` → **BLOCKED**, ranged audio →
**BLOCKED**, `api.github.com` → OK (it sends `ACAO: *`, so it passes anywhere).
Conclusion: the world is standard page-origin CORS-bound, so tag reading must
be done by the service worker, which is not.

Everything below exists to satisfy one contract:

```js
AFP_RANGE_FETCH = async (url, start, end) => Uint8Array | null;
```

Two calls per track: `bytes=0-9` (ID3 header, declares tag length), then
`bytes=10-N` (the tag, ~1–50 KB). If the first doesn't start with `ID3` the
second never fires. Audio data and album art are never fetched.

---

## 1. manifest.json

```jsonc
{
  "permissions": ["userScripts"],
  "host_permissions": ["https://*/*", "http://*/*"],   // you already have this
  "background": { "service_worker": "background.js" }
}
```

`host_permissions` is the thing that makes the worker CORS-exempt. Nothing else
grants that.

---

## 2. background.js — append this

Handles both entry points, because messages from a USER_SCRIPT world arrive on
a **different event** than messages from a content script:

| Sender | Event |
|---|---|
| ISOLATED content script | `chrome.runtime.onMessage` |
| USER_SCRIPT world | `chrome.runtime.onUserScriptMessage` |

Registering both means the same worker serves either path.

```js
async function afpRangeFetch(msg) {
  const ctrl  = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetch(msg.url, {
      headers: { Range: `bytes=${msg.start}-${msg.end}` },
      signal: ctrl.signal,
      credentials: 'omit',          // never attach cookies to third-party audio hosts
      cache: 'no-store'
    });

    // 206 = Range honoured. 200 = server ignored it and is sending the WHOLE
    // file — fine for the 10-byte header read, but refuse it on anything large
    // or a 50 MB download arrives for a 10-byte request.
    if (res.status !== 206 && res.status !== 200) return { ok: false };
    if (res.status === 200 && (+res.headers.get('content-length') || 0) > 2_000_000)
      return { ok: false };

    const buf = new Uint8Array(await res.arrayBuffer());
    // Plain array: typed arrays don't survive the sendMessage clone reliably.
    // Reads are tiny, so the overhead is irrelevant.
    return { ok: true, bytes: Array.from(buf) };
  } catch (_) {
    return { ok: false };
  } finally {
    clearTimeout(timer);
  }
}

const afpHandler = (msg, sender, sendResponse) => {
  if (!msg || msg.type !== 'afp-range') return;    // not ours, let others handle it
  afpRangeFetch(msg).then(sendResponse);
  return true;                                      // keep the channel open for async
};

chrome.runtime.onMessage.addListener(afpHandler);
if (chrome.runtime.onUserScriptMessage)             // guarded: older Chrome lacks it
  chrome.runtime.onUserScriptMessage.addListener(afpHandler);
```

---

## 3. Pick a path

### Path A — custom code stays in USER_SCRIPT world *(simplest)*

Call this once in the service worker at startup:

```js
chrome.userScripts.configureWorld({ messaging: true });
```

That exposes `chrome.runtime.sendMessage` to the USER_SCRIPT world. No DOM
bridge needed. Then prepend to your custom code:

```js
AFP_RANGE_FETCH = async (url, start, end) => {
  try {
    const r = await chrome.runtime.sendMessage({ type: 'afp-range', url, start, end });
    return r && r.ok ? new Uint8Array(r.bytes) : null;
  } catch (_) { return null; }
};
```

**Cost:** the four deep interceptors will not work — USER_SCRIPT is not MAIN.
DOM scanning still finds `<a href>`, `<audio>` and `<source>`; dynamically
created streams are missed.

### Path B — MAIN world *(required for the interceptors)*

MAIN world cannot use `chrome.runtime` at all, and `configureWorld({messaging})`
does not apply to it. So it needs a relay through your ISOLATED content script.

**content.js (ISOLATED) — append:**

```js
window.addEventListener('message', e => {
  const d = e.data;
  if (e.source !== window || !d || d.__afpBridge !== 1 || d.reply) return;
  chrome.runtime.sendMessage(
    { type: 'afp-range', url: d.url, start: d.start, end: d.end },
    r => window.postMessage({
      __afpBridge: 1, id: d.id, reply: true,
      ok:    !chrome.runtime.lastError && r && r.ok,
      bytes: r && r.ok ? r.bytes : null
    }, '*')
  );
});
```

**custom code (MAIN) — prepend:**

```js
var AFP_USE_BRIDGE = true;   // player uses its built-in postMessage relay
```

The player's `bridgeRange` already speaks this exact protocol, including a 6s
timeout so a missing relay degrades instead of hanging.

If you'd rather route through your existing `data-qk-run-*` bridge, skip
`AFP_USE_BRIDGE` and define `AFP_RANGE_FETCH` directly against your own
`http()` helper — it takes priority over every built-in transport.

---

## 4. Confirm it works

Run in the same world as your custom code:

```js
const b = await AFP_RANGE_FETCH(
  'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-1.mp3', 0, 9);
toast(b ? 'got ' + b.length + ' bytes: ' + String.fromCharCode(b[0],b[1],b[2]) : 'null');
```

Expect **`got 10 bytes: ID3`**. `null` means the bridge or worker isn't wired.
Anything other than `ID3` means the file has no tag — the transport still worked.

---

## 5. Which world am I actually in?

The CORS probe can't answer this — MAIN and USER_SCRIPT are both CORS-bound.
An injected inline `<script>` always executes in MAIN, so:

```js
const s = document.createElement('script');
s.textContent = 'window.__afp_sentinel = 42;';
document.documentElement.appendChild(s); s.remove();
toast('world = ' + (window.__afp_sentinel === 42 ? 'MAIN' : 'ISOLATED/USER_SCRIPT'));
```

MAIN → interceptors work, use Path B.
Otherwise → interceptors are inert, and Path A is the honest choice.

---

## Unchanged

`player.html` and `mobile-player.html` stay on GitHub Pages. The player needs
one fixed origin so windows opened from different sites share a queue, and the
QR handoff link has to be openable by a phone — a `chrome-extension://` URL
isn't.
