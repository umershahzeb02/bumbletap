# HANDOFF — "new audio is not added" (unresolved)

## The bug

User adds audio on a page. Nothing is added. The player window shows the same
three tracks it has shown for a while. No error surfaced to the user.

Three fixes have shipped for this add-path already and **none changed the
symptom**. Do not assume the previous diagnosis was right — it probably wasn't.

## Where everything is

```
repo    C:\Users\Lenovo\OneDrive\Desktop\me-random\bumbletap
files   scripts/audio-player/
          audio-float-player.js   runs in the USER'S EXTENSION (not served)
          player.html             the player window        (served)
          queue-bridge.html       hidden iframe write-head (served)
          mobile-player.html      QR receiver              (served)
          id3.js                  tag reader               (served)
live    https://umershahzeb02.github.io/bumbletap/scripts/audio-player/
```

## User's actual environment (measured, not assumed)

- Custom Chrome extension, **not** Tampermonkey.
- Script runs in the **USER_SCRIPT world** — confirmed by an injected-`<script>`
  sentinel test returning `ISOLATED/USER_SCRIPT`.
- `host_permissions: ["https://*/*","http://*/*"]`, and an `http()` helper that
  does privileged ranged fetches. Confirmed working: `example.com` ranged read
  returned `10B [<!d]`, a real audio host returned `10B [ID3]`.
- Plain `fetch` in that world **is** CORS-bound: `example.com` and ranged audio
  both BLOCKED, `api.github.com` OK (it sends `ACAO:*`, so it proves nothing).

## Architecture of the add path

```
page (USER_SCRIPT world)
  └─ sendToPlayer() → pending[]
       └─ hidden iframe: queue-bridge.html   (player origin, github.io)
            ├─ writes localStorage '__afp_queue_v1'
            └─ BroadcastChannel '__afp_player_sync' → open player windows
```

The iframe exists because a popup reference dies on navigation, and the page
cannot see across origins — that caused an earlier bug where every add opened a
new window. Player windows heartbeat on the channel so the bridge can report
liveness upward.

## TOP SUSPECT — an assumption never verified

`audio-float-player.js` listens with `W.addEventListener('message', …)` where
`W = unsafeWindow || window`. In the USER_SCRIPT world `unsafeWindow` is
undefined, so `W` is the **isolated world's** window.

`queue-bridge.html` replies with `parent.postMessage(...)`, which targets the
**page's** window.

**It was assumed, never tested, that a USER_SCRIPT-world listener receives
those.** If it does not, then `bridge-ready` never arrives → `bridgeReady`
stays false → `pending` never flushes → **every add is silently dropped**,
which is exactly the reported symptom.

Verify this first. It is cheap to test and it explains everything.

If confirmed, the fix is to not depend on `postMessage` reaching that world —
e.g. have the page poll the iframe, use a `MessageChannel` port passed at
creation, or move the write into the extension's own bridge (the user already
has a working `data-qk-run-*` relay to their service worker).

## Other candidates, in order

2. **The extension is running an old copy of the script.** It is pasted in, not
   served, so pushing to Pages does not update it. If no
   `iframe[src*="queue-bridge"]` exists in the page DOM, this is it.
3. **CSP blocks the iframe.** Many sites set `frame-src`. A 4s timeout +
   fallback to the player window was added for this (commit `e02e085`) but is
   **unpushed and untested in the real extension**.
4. `e.origin !== PLAYER_ORIGIN` rejecting the reply for some reason.

## Already verified locally — do not re-do

| Thing | Result |
|---|---|
| QR encode/decode round trip | passes, incl. unicode + query strings |
| ID3 parser | 17/17 (v2.2/2.3/2.4, UTF-8/UTF-16+BOM, failure paths) |
| MAIN-world interception shim | 8/8, builds no UI in `intercept` role |
| Bridge liveness cycle | false → true on open → false ~5s after close |
| Bridge write → open player window | track arrives with correct site |
| `mobile-player.html` | unchanged by all of this (`similarity index 100%`) |

All of that was tested with **plain pages on localhost**, never inside the
user's extension. That gap is where the bug lives.

## Constraints

- **Cannot push.** `github.com` does not resolve from this environment
  (`github.io` does). Two commits are unpushed: `bc5d80e`, `e02e085`. The user
  must push.
- **Cannot see a rendered browser.** The automation window stays minimized, so
  `document.visibilityState` is permanently `hidden` — IntersectionObserver,
  `preload="metadata"` and timers are all suspended there. Anything needing a
  painted page cannot be confirmed from here.
- **Cannot install the extension.** Ask the user to run diagnostics.

## What good looks like

Adding a track on any page puts it in the queue, visible in an open player
window, with no popup spam and no silent failure. If a path can fail, it must
surface a toast or console warning — silent dropping is what made this take so
long to find.

## Ask the user for, if you need it

- Console output on a failing add (esp. red CSP errors mentioning `frame-src`)
- Whether `document.querySelector('iframe[src*="queue-bridge"]')` is non-null
- Whether their extension copy of the script contains the string `BRIDGE_URL`
