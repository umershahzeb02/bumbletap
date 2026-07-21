# bumbletap

Browser tooling hosted on GitHub Pages. Two independent projects, each a folder
under `scripts/`, sharing one Pages deployment.

| Project | What it does |
|---|---|
| [`scripts/remote-tab-control`](scripts/remote-tab-control) | Control any browser tab from your phone — trackpad, scroll, d-pad, keyboard |
| [`scripts/audio-player`](scripts/audio-player) | Detect audio on any page, queue it across sites, hand the queue to your phone by QR |

Live at `https://umershahzeb02.github.io/bumbletap/`.

## Layout

```
scripts/
├── remote-tab-control/
│   ├── controller.html          phone-side controller (the QR target)
│   ├── bridge.html              WebRTC popup (iframes restrict WebRTC)
│   ├── remote-control.js        desktop script — inject this
│   └── trystero-*.min.js        bundled P2P signalling
└── audio-player/
    ├── player.html              desktop queue/player window
    ├── mobile-player.html       phone-side receiver (the QR target)
    ├── audio-float-player.js    page script — inject this
    ├── id3.js                   ID3v2 tag reader
    └── EXTENSION-SETUP.md       Chrome extension wiring
```

Both projects host a page that a phone opens by QR, so both need real public
URLs — a `chrome-extension://` page can't be opened from a phone.

## Paths are baked into the scripts

Moving a folder means updating the constant that points at it:

| Constant | File | Points at |
|---|---|---|
| `CONTROLLER_URL` | `remote-tab-control/remote-control.js` | `controller.html` |
| `PLAYER_URL` | `audio-player/audio-float-player.js` | `player.html` |
| `@require` header | `audio-player/audio-float-player.js` | `id3.js` |
| `RECEIVER` | `audio-player/player.html` | `mobile-player.html` |

`bridge.html` is derived from `CONTROLLER_URL`, and `trystero-*.min.js` loads
relatively, so neither needs its own constant as long as those files stay beside
`controller.html`.

---

# Remote Tab Control

Control any browser tab from your phone. Scroll, click, type — all from a
touchpad on your phone.

## How it works

1. **Desktop**: inject `remote-control.js` into any tab (Tampermonkey, browser
   extension, or console)
2. **Phone**: scan the QR code that appears — it opens the controller page
3. **Connected**: your phone becomes a trackpad, scroll controller, d-pad and
   keyboard for that tab

Connection is peer-to-peer via WebRTC. Signalling uses
[trystero](https://github.com/dmotz/trystero) over public WebTorrent trackers —
no accounts, no server, no API keys. Once connected, data flows directly between
your devices.

## Setup

Pages is already enabled on this repo, so the controller is live at
`https://umershahzeb02.github.io/bumbletap/scripts/remote-tab-control/controller.html`.

If you fork it, update `CONTROLLER_URL` at the top of `remote-control.js` to your
own Pages URL, then inject the script:

- **Tampermonkey/Violentmonkey** (recommended) — new script, paste the contents
- **Browser extension** — add as a content script for the domains you want
- **Console** — paste into DevTools on any page

## Phone controller modes

| Mode | Controls |
|---|---|
| **Trackpad** | 1 finger = cursor, tap = click, 2 fingers = scroll, double tap = dblclick, long press = focus |
| **Scroll** | Swipe to scroll, drag sidebar to jump to position |
| **D-Pad** | Directional buttons for scrolling + centre tap button |
| **Keyboard** | Text input + special keys (Enter, Tab, Backspace, Esc, Space) |

Bottom nav bar, always visible: Back, Top, Reload, Bottom, Forward.

## Requirements

- Both devices need internet (for the tracker signalling handshake)
- The phone controller must be served over HTTPS — Pages handles this
- The desktop script works on any origin, HTTP or HTTPS

## Troubleshooting

**Connection times out** — both devices need internet. Check that WebSocket
connections to WebTorrent trackers (port 443) aren't blocked by a firewall or
proxy.

**Still not connecting** — refresh both sides. Trystero uses multiple trackers
for redundancy, but public trackers can be slow; connection normally takes 2–5
seconds.

---

# Audio Float Player

Detects audio on any page, collects it into one queue that follows you across
sites, and hands the whole queue to your phone with a QR code.

## How it works

1. `audio-float-player.js` runs on a page and finds audio — links, `<audio>`
   elements, and (in the MAIN world) streams the page builds in JavaScript
2. A floating pill shows what it found; clicking sends a track to the player
3. `player.html` opens as a popup and holds the queue
4. **Send to Phone** encodes the queue into a QR code pointing at
   `mobile-player.html`

## Why the player is hosted rather than inlined

The queue used to be stuck on one hostname. The player was written into an
`about:blank` popup, and such a popup **inherits the opener's origin** — while
`BroadcastChannel` and `localStorage` are origin-scoped. A popup opened from site
A and one opened from site B could never see each other's queue.

Serving `player.html` from one fixed origin means every player window shares an
origin no matter which site opened it, so they share one queue. Page-to-player
traffic crosses origins via `postMessage`.

## Injection worlds

The four deep interceptors (`HTMLMediaElement.prototype.src`, `Audio`, `fetch`,
`XHR`) only work in the page's own world. In a Chrome extension's ISOLATED or
USER_SCRIPT world they patch objects the page never touches and detect nothing —
silently.

The script detects its own world at runtime and skips those patches where they'd
be inert. It also has two roles:

| `AFP_ROLE` | World | Behaviour |
|---|---|---|
| `'intercept'` | MAIN | Installs the four patches, reports findings by `postMessage`. No UI. |
| unset (default) | any | Builds the full player. In page context, installs the patches inline too. |

Under Tampermonkey with page-context execution, one copy does both jobs. In an
extension, register the same file twice — see
[`EXTENSION-SETUP.md`](scripts/audio-player/EXTENSION-SETUP.md).

## Track titles

Titles come from the best source available, in order:

1. `navigator.mediaSession.metadata` — what the site already told the OS
2. JSON-LD `AudioObject` / `PodcastEpisode`
3. DOM proximity — labels, ancestors, siblings
4. `og:title`, skipped when it's just the site name
5. `document.title` minus site affixes, skipped when it *is* the site name
6. Cleaned filename

ID3 tags from the file itself override these when readable. That needs a ranged
HTTP request, which CORS normally blocks — so it runs through
`GM_xmlhttpRequest`, an extension background worker, or a host-supplied
`AFP_RANGE_FETCH`. Two small requests read the tag header and frames; audio data
and album art are never downloaded.

Each track also records **the site you found it on**, which is often not the host
serving the file — a clip found on `bbc.co.uk` may live on an Akamai CDN.

## Tech

Vanilla JS, no frameworks, no build step. `id3.js` and the QR encoder are both
self-contained.

---

## License

MIT — do whatever you want with it.
