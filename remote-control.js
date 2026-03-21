// ==UserScript==
// @name         Remote Tab Control — Desktop
// @description  Control this tab from your phone. Inject and scan QR.
// @match        *://*/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(() => {
  // ========== CONFIGURATION ==========
  // Change this to your GitHub Pages URL after deploying
  const CONTROLLER_URL = 'https://umershahzeb02.github.io/remote-tab-control/controller.html';

  const PEER_ID = 'rc-' + Math.random().toString(36).substring(2, 10);
  const ICE_SERVERS = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'turn:freestun.net:3478', username: 'free', credential: 'free' },
    { urls: 'turn:openrelay.metered.ca:80', username: 'openrelayproject', credential: 'openrelayproject' },
    { urls: 'turn:openrelay.metered.ca:443', username: 'openrelayproject', credential: 'openrelayproject' },
  ];

  let peer = null, conn = null, connected = false;
  let phoneCursor = null, highlightEl = null;
  let scrollAccX = 0, scrollAccY = 0, scrollRaf = null;

  function log(...a) { console.log('%c[Remote]', 'color:#6366f1;font-weight:bold', ...a); }

  // function loadScript(url) {
  //   return new Promise((res, rej) => {
  //     if (document.querySelector(`script[src="${url}"]`)) return res();
  //     const s = document.createElement('script');
  //     s.src = url; s.onload = res; s.onerror = rej;
  //     document.head.appendChild(s);
  //   });
  // }

  // ========== INIT ==========
  async function init() {
    try {
      await loadScript('https://cdnjs.cloudflare.com/ajax/libs/peerjs/1.5.4/peerjs.min.js');
      await loadScript('https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js');
      log('Scripts loaded');
    } catch (e) { log('Load failed:', e); return; }
    injectStyles();
    createUI();
    createCursor();
    startPeer();
  }

  // ========== STYLES ==========
  function injectStyles() {
    const s = document.createElement('style');
    s.textContent = `
.__rc-overlay{position:fixed;inset:0;background:rgba(0,0,0,.7);backdrop-filter:blur(8px);z-index:9999999;display:flex;align-items:center;justify-content:center;font-family:-apple-system,system-ui,sans-serif}
.__rc-card{background:#111118;border:1px solid #25252f;border-radius:20px;padding:32px;max-width:380px;width:92%;text-align:center;box-shadow:0 20px 60px rgba(0,0,0,.5)}
.__rc-title{font-size:18px;font-weight:700;color:#e8e8ed;margin-bottom:4px}
.__rc-sub{font-size:12px;color:#6b6b80;margin-bottom:20px;line-height:1.5}
.__rc-qr{background:#fff;border-radius:12px;padding:16px;display:inline-block;margin-bottom:16px;line-height:0}
.__rc-qr canvas{display:block!important}
.__rc-code{font-family:'Courier New',monospace;font-size:16px;font-weight:700;color:#6366f1;background:rgba(99,102,241,.08);border:1px solid rgba(99,102,241,.2);padding:8px 18px;border-radius:8px;display:inline-block;margin-bottom:16px;letter-spacing:.05em;cursor:pointer;user-select:all}
.__rc-btn{background:none;border:1px solid #25252f;color:#6b6b80;padding:8px 20px;border-radius:8px;font-size:12px;font-weight:600;cursor:pointer;font-family:inherit}
.__rc-btn:hover{color:#e8e8ed;border-color:#3a3a48;background:#1a1a24}
.__rc-status{position:fixed;top:14px;right:14px;z-index:9999998;background:rgba(15,15,20,.92);backdrop-filter:blur(8px);border:1px solid #25252f;border-radius:10px;padding:7px 14px;display:flex;align-items:center;gap:8px;font-family:-apple-system,system-ui,sans-serif;font-size:11px;color:#8888a0;cursor:pointer;box-shadow:0 4px 16px rgba(0,0,0,.3)}
.__rc-dot{width:7px;height:7px;border-radius:50%;background:#ef4444;flex-shrink:0}
.__rc-dot.on{background:#34d399;box-shadow:0 0 6px rgba(52,211,153,.5)}
.__rc-cursor{position:fixed;z-index:9999997;pointer-events:none;width:22px;height:22px;display:none}
.__rc-cursor.v{display:block}
.__rc-cursor svg{width:100%;height:100%;filter:drop-shadow(0 2px 3px rgba(0,0,0,.5))}
.__rc-hl{position:fixed;z-index:9999995;pointer-events:none;border:2px solid rgba(99,102,241,.4);border-radius:3px;background:rgba(99,102,241,.06);display:none}
.__rc-hl.v{display:block}
.__rc-rip{position:fixed;z-index:9999996;pointer-events:none;width:36px;height:36px;border-radius:50%;border:2px solid rgba(99,102,241,.5);animation:__rcrip .4s ease-out forwards}
@keyframes __rcrip{0%{transform:translate(-50%,-50%) scale(.3);opacity:1}100%{transform:translate(-50%,-50%) scale(2);opacity:0}}
    `;
    document.head.appendChild(s);
  }

  // ========== UI ==========
  function createUI() {
    const connectUrl = CONTROLLER_URL + '#' + PEER_ID;

    const overlay = document.createElement('div');
    overlay.className = '__rc-overlay';
    overlay.id = '__rc-overlay';
    overlay.addEventListener('click', e => { if (e.target === overlay) toggleOverlay(); });

    const card = document.createElement('div');
    card.className = '__rc-card';

    const title = document.createElement('div');
    title.className = '__rc-title';
    title.textContent = '📱 Remote Control';

    const sub = document.createElement('div');
    sub.className = '__rc-sub';
    sub.textContent = 'Scan the QR code with your phone camera to connect.';

    const qrBox = document.createElement('div');
    qrBox.className = '__rc-qr';
    qrBox.id = '__rc-qr';

    const orDiv = document.createElement('div');
    orDiv.style.cssText = 'font-size:10px;color:#44445a;margin:8px 0;text-transform:uppercase;letter-spacing:.1em';
    orDiv.textContent = 'or enter code';

    const code = document.createElement('div');
    code.className = '__rc-code';
    code.id = '__rc-code';
    code.textContent = PEER_ID;
    code.title = 'Click to copy';
    code.addEventListener('click', () => {
      navigator.clipboard.writeText(PEER_ID);
      code.textContent = 'Copied!';
      setTimeout(() => code.textContent = PEER_ID, 1200);
    });

    const br = document.createElement('br');
    const closeBtn = document.createElement('button');
    closeBtn.className = '__rc-btn';
    closeBtn.textContent = 'Minimize';
    closeBtn.addEventListener('click', toggleOverlay);

    card.append(title, sub, qrBox, orDiv, code, br, closeBtn);
    overlay.appendChild(card);
    document.body.appendChild(overlay);

    // Generate QR — pointing to the controller URL with peer ID as hash
    setTimeout(() => {
      new QRCode(qrBox, {
        text: connectUrl,
        width: 180, height: 180,
        colorDark: '#111', colorLight: '#fff',
        correctLevel: QRCode.CorrectLevel.M
      });
      // Kill duplicate img that QRCode.js creates
      const kill = () => qrBox.querySelectorAll('img').forEach(i => i.remove());
      kill(); setTimeout(kill, 50); setTimeout(kill, 200); setTimeout(kill, 500); setTimeout(kill, 1000);
    }, 100);

    // Status badge
    const status = document.createElement('div');
    status.className = '__rc-status';
    status.id = '__rc-status';
    status.addEventListener('click', toggleOverlay);

    const dot = document.createElement('div');
    dot.className = '__rc-dot';
    dot.id = '__rc-dot';

    const txt = document.createElement('span');
    txt.id = '__rc-stxt';
    txt.textContent = 'Waiting...';

    status.append(dot, txt);
    document.body.appendChild(status);
  }

  function toggleOverlay() {
    const o = document.getElementById('__rc-overlay');
    if (o) o.style.display = o.style.display === 'none' ? 'flex' : 'none';
  }

  // ========== CURSOR & HIGHLIGHT ==========
  function createCursor() {
    phoneCursor = document.createElement('div');
    phoneCursor.className = '__rc-cursor';
    phoneCursor.innerHTML = '<svg viewBox="0 0 24 24" fill="none"><path d="M4 2L20 12L12 14L8 22L4 2Z" fill="#6366f1" stroke="#fff" stroke-width="1.5" stroke-linejoin="round"/></svg>';
    document.body.appendChild(phoneCursor);
    highlightEl = document.createElement('div');
    highlightEl.className = '__rc-hl';
    document.body.appendChild(highlightEl);
  }

  // ========== SAFE SEND ==========
  function send(d) { try { if (conn && conn.open) conn.send(d); } catch (e) { log('Send err:', e.message); } }

  function sendPageInfo() {
    send({
      type: 'page-info', title: document.title, url: location.href,
      scrollY: window.scrollY,
      scrollHeight: document.documentElement.scrollHeight,
      viewportHeight: window.innerHeight,
      viewportWidth: window.innerWidth,
    });
  }

  // ========== PEERJS ==========
  function startPeer() {
    peer = new Peer(PEER_ID, { debug: 2, config: { iceServers: ICE_SERVERS } });

    peer.on('open', id => log('Peer ready:', id));

    peer.on('connection', c => {
      log('Incoming connection, open:', c.open);
      conn = c;

      // Debug — use addEventListener so PeerJS can't overwrite our handlers
      const pc = c.peerConnection;
      if (pc) {
        pc.addEventListener('iceconnectionstatechange', () => log('ICE state:', pc.iceConnectionState));
        pc.addEventListener('connectionstatechange', () => log('Conn state:', pc.connectionState));
        pc.addEventListener('icegatheringstatechange', () => log('ICE gathering:', pc.iceGatheringState));
        pc.addEventListener('signalingstatechange', () => log('Signaling:', pc.signalingState));
      } else {
        log('WARNING: peerConnection not available yet');
      }

      // Poll all states every second for debugging
      const dbg = setInterval(() => {
        const p = c.peerConnection;
        if (p) log('POLL ice:', p.iceConnectionState, 'conn:', p.connectionState, 'signal:', p.signalingState, 'dc-open:', c.open);
        if (connected) clearInterval(dbg);
      }, 1000);

      const onReady = () => {
        if (connected) return;
        connected = true;
        clearInterval(dbg);
        log('Phone connected!');
        document.getElementById('__rc-dot').classList.add('on');
        document.getElementById('__rc-stxt').textContent = 'Connected';
        document.getElementById('__rc-overlay').style.display = 'none';
        sendPageInfo();
      };

      c.on('open', onReady);

      // Fallback poll
      let polls = 0;
      const pt = setInterval(() => {
        polls++;
        if (c.open && !connected) { clearInterval(pt); onReady(); }
        if (polls > 60 || connected) clearInterval(pt);
      }, 200);

      c.on('data', handleCommand);

      c.on('close', () => {
        connected = false; conn = null;
        document.getElementById('__rc-dot').classList.remove('on');
        document.getElementById('__rc-stxt').textContent = 'Disconnected';
        phoneCursor.classList.remove('v'); highlightEl.classList.remove('v');
        log('Phone disconnected');
      });

      c.on('error', e => log('Conn error:', e));
    });

    peer.on('error', e => {
      log('Peer error:', e);
      document.getElementById('__rc-stxt').textContent = 'Error';
    });

    peer.on('disconnected', () => { log('Reconnecting...'); peer.reconnect(); });
  }

  // ========== COMMAND HANDLER ==========
  function handleCommand(d) {
    if (!d?.type) return;
    switch (d.type) {
      case 'scroll':
        window.scrollBy({ top: d.dy || 0, left: d.dx || 0, behavior: d.smooth ? 'smooth' : 'auto' });
        sendPageInfo(); break;

      case 'scroll-smooth':
        scrollAccX += (d.dx || 0); scrollAccY += (d.dy || 0);
        if (!scrollRaf) {
          scrollRaf = requestAnimationFrame(function tick() {
            if (Math.abs(scrollAccX) > .5 || Math.abs(scrollAccY) > .5) {
              window.scrollBy(scrollAccX, scrollAccY);
              scrollAccX *= .85; scrollAccY *= .85;
              scrollRaf = requestAnimationFrame(tick);
            } else { scrollAccX = 0; scrollAccY = 0; scrollRaf = null; sendPageInfo(); }
          });
        } break;

      case 'scroll-to': {
        const t = d.percent * (document.documentElement.scrollHeight - window.innerHeight);
        window.scrollTo({ top: t, behavior: 'smooth' });
        setTimeout(sendPageInfo, 300); break;
      }

      case 'cursor-move': {
        const x = d.x * window.innerWidth, y = d.y * window.innerHeight;
        phoneCursor.style.left = x + 'px'; phoneCursor.style.top = y + 'px';
        phoneCursor.classList.add('v');
        const el = document.elementFromPoint(x, y);
        if (el && el !== document.body && el !== document.documentElement) {
          const r = el.getBoundingClientRect();
          Object.assign(highlightEl.style, { left: r.left+'px', top: r.top+'px', width: r.width+'px', height: r.height+'px' });
          highlightEl.classList.add('v');
        } else highlightEl.classList.remove('v');
        break;
      }

      case 'cursor-hide':
        phoneCursor.classList.remove('v'); highlightEl.classList.remove('v'); break;

      case 'click': {
        const x = d.x * window.innerWidth, y = d.y * window.innerHeight;
        const rip = document.createElement('div');
        rip.className = '__rc-rip'; rip.style.left = x+'px'; rip.style.top = y+'px';
        document.body.appendChild(rip); setTimeout(() => rip.remove(), 500);
        const t = document.elementFromPoint(x, y);
        if (t) t.click(); break;
      }

      case 'dblclick': {
        const x = d.x * window.innerWidth, y = d.y * window.innerHeight;
        const t = document.elementFromPoint(x, y);
        if (t) t.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, clientX: x, clientY: y }));
        break;
      }

      case 'key': {
        const kt = document.activeElement || document.body;
        kt.dispatchEvent(new KeyboardEvent('keydown', { key: d.key, code: d.code || '', bubbles: true }));
        kt.dispatchEvent(new KeyboardEvent('keyup', { key: d.key, code: d.code || '', bubbles: true }));
        break;
      }

      case 'type': {
        const a = document.activeElement;
        if (a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.isContentEditable)) {
          if (a.isContentEditable) document.execCommand('insertText', false, d.text);
          else { a.value += d.text; a.dispatchEvent(new Event('input', { bubbles: true })); }
        } break;
      }

      case 'navigate':
        if (d.action === 'back') history.back();
        else if (d.action === 'forward') history.forward();
        else if (d.action === 'reload') location.reload();
        else if (d.action === 'top') window.scrollTo({ top: 0, behavior: 'smooth' });
        else if (d.action === 'bottom') window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'smooth' });
        setTimeout(sendPageInfo, 500); break;

      case 'select': {
        const el = document.elementFromPoint(d.x * window.innerWidth, d.y * window.innerHeight);
        if (el) { el.focus(); send({ type: 'focused', tag: el.tagName, id: el.id }); }
        break;
      }

      case 'ping': send({ type: 'pong', t: Date.now() }); break;
      case 'get-info': sendPageInfo(); break;
      case 'disconnect': if (conn) conn.close(); break;
    }
  }

  // ========== KEEPALIVE ==========
  setInterval(() => { if (connected) send({ type: 'heartbeat' }); }, 5000);
  window.addEventListener('beforeunload', () => { send({ type: 'tab-closing' }); if (conn) conn.close(); if (peer) peer.destroy(); });

  init();
})();
