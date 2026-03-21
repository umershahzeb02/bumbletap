# Remote Tab Control

Control any browser tab from your phone. Scroll, click, type -- all from a touchpad on your phone.

## How it works

1. **Desktop**: Inject `remote-control.js` into any tab (via Tampermonkey, browser extension, or console)
2. **Phone**: Scan the QR code that appears -- it opens the controller page
3. **Connected**: Your phone becomes a trackpad, scroll controller, d-pad, and keyboard for that tab

Connection is peer-to-peer via WebRTC. Signaling is handled by [trystero](https://github.com/dmotz/trystero) using public WebTorrent tracker servers -- no accounts, no server setup, no API keys. Once connected, data flows directly between your devices.

## Setup

### Step 1: Deploy the controller page

Push this repo to GitHub and enable GitHub Pages:

1. Go to your repo -> **Settings** -> **Pages**
2. Set source to `master` branch, root folder
3. Save -- your controller will be at `https://YOURUSERNAME.github.io/remote-tab-control/controller.html`

### Step 2: Update the desktop script

Open `remote-control.js` and change the `CONTROLLER_URL` constant to match your GitHub Pages URL:

```js
const CONTROLLER_URL = 'https://YOURUSERNAME.github.io/remote-tab-control/controller.html';
```

### Step 3: Inject the desktop script

**Option A -- Tampermonkey/Violentmonkey** (recommended)

Install the userscript manager extension, create a new script, paste the contents of `remote-control.js`.

**Option B -- Browser extension**

Add `remote-control.js` as a content script for the domains you want.

**Option C -- Console**

Copy-paste `remote-control.js` into DevTools console on any page.

## Phone Controller Modes

| Mode | Controls |
|------|----------|
| **Trackpad** | 1 finger = cursor, tap = click, 2 fingers = scroll, double tap = dblclick, long press = focus |
| **Scroll** | Swipe to scroll, drag sidebar to jump to position |
| **D-Pad** | Directional buttons for scrolling + center tap button |
| **Keyboard** | Text input + special keys (Enter, Tab, Backspace, Esc, Space) |

Bottom nav bar (always visible): Back, Top, Reload, Bottom, Forward.

## Requirements

- Both devices need internet access (for the WebTorrent tracker signaling handshake)
- Phone controller must be served over HTTPS (GitHub Pages handles this)
- Desktop script works on any origin (HTTP or HTTPS)

## How it connects

1. Desktop script generates a random room ID and shows a QR code
2. QR code links to `https://your-gh-pages-url/controller.html#ROOM_ID`
3. Phone opens the link, both sides join the same trystero room via WebTorrent trackers
4. WebRTC data channel opens -- all subsequent communication is direct P2P
5. Connection persists until tab closes or you disconnect manually

## Troubleshooting

**QR shows duplicate image**: The script auto-removes duplicates. If you still see two, hard-refresh the page.

**Connection times out**: Both devices need internet. Make sure WebSocket connections to WebTorrent trackers (port 443) are not blocked by a firewall or proxy.

**Still not connecting**: Try refreshing both sides. Trystero connects to multiple trackers for redundancy, but public trackers can occasionally be slow. Connection typically takes 2-5 seconds.

## Tech Stack

- [trystero](https://github.com/dmotz/trystero) (torrent strategy) -- serverless WebRTC signaling via WebTorrent trackers
- [QRCode.js](https://github.com/davidshimjs/qrcodejs) -- QR code generation on the desktop side
- Vanilla JS -- no frameworks, no build step

## License

MIT -- do whatever you want with it.
