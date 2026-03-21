# Remote Tab Control

Control any browser tab from your phone. Scroll, click, type — all from a touchpad on your phone.

## How it works

1. **Desktop**: Inject `remote-control.js` into any tab (via Tampermonkey, browser extension, or console)
2. **Phone**: Scan the QR code that appears — it opens the controller page over HTTPS
3. **Connected**: Your phone becomes a trackpad, scroll controller, d-pad, and keyboard for that tab

Connection is peer-to-peer via WebRTC (PeerJS). Data flows directly between your devices — no server relay.

## Setup

### Step 1: Deploy the controller page

Push this repo to GitHub and enable GitHub Pages:

1. Go to your repo → **Settings** → **Pages**
2. Set source to `main` branch, root folder
3. Save — your controller will be at `https://YOURUSERNAME.github.io/remote-tab-control/controller.html`

### Step 2: Update the desktop script

Open `remote-control.js` and change line 7:

```js
const CONTROLLER_URL = 'https://YOURUSERNAME.github.io/remote-tab-control/controller.html';
```

### Step 3: Inject the desktop script

**Option A — Tampermonkey/Violentmonkey** (recommended)

Install the userscript manager extension, create a new script, paste the contents of `remote-control.js`.

**Option B — Browser extension**

Add `remote-control.js` as a content script for the domains you want.

**Option C — Console**

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

- Both devices need internet access (for the initial PeerJS signaling handshake)
- Phone controller **must** be served over HTTPS (GitHub Pages handles this)
- Desktop script works on any origin (HTTP or HTTPS)

## How it connects

1. Desktop script generates a random peer ID and shows a QR code
2. QR code links to `https://your-gh-pages-url/controller.html#PEER_ID`
3. Phone opens the link, PeerJS connects to the signaling server, finds the desktop peer
4. WebRTC data channel opens — all subsequent communication is direct P2P
5. Connection persists until tab closes or you disconnect manually

## Troubleshooting

**QR shows duplicate image**: The script auto-removes duplicates. If you still see two, hard-refresh the page.

**Connection times out**: Both devices need internet. PeerJS cloud signaling runs on port 443 — make sure it's not blocked.

**Works on same WiFi but not cross-network**: You may need TURN servers. Sign up for free at [openrelayproject.org](https://www.metered.ca/tools/openrelay/) and add the TURN credentials to the `ICE_SERVERS` array in both files.

## License

MIT — do whatever you want with it.
