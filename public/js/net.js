/**
 * WebSocket link to the signalling server.
 * Reconnects on its own and replays the identity handshake, so a laptop lid or
 * a phone changing Wi-Fi band recovers without the user noticing.
 */
export class Net extends EventTarget {
  constructor() {
    super();
    this.ws = null;
    this.credentials = null;
    this.selfId = null;
    this.latency = null;
    this.state = 'idle'; // idle | connecting | online | offline
    this.attempts = 0;
    this.queue = [];
    this.wantOpen = false;
    this.pingTimer = null;
    this.retryTimer = null;
  }

  get url() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    return `${proto}://${location.host}/ws`;
  }

  connect(credentials) {
    this.credentials = credentials ?? this.credentials;
    this.wantOpen = true;
    this.open();
  }

  open() {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return;
    }
    this.setState('connecting');

    let ws;
    try {
      ws = new WebSocket(this.url);
    } catch {
      this.scheduleRetry();
      return;
    }
    this.ws = ws;

    ws.onopen = () => {
      this.attempts = 0;
      ws.send(JSON.stringify({ t: 'hello', ...this.credentials }));
    };

    ws.onmessage = (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }

      if (msg.t === 'welcome') {
        this.selfId = msg.self.id;
        this.setState('online');
        this.flush();
        this.startPings();
      } else if (msg.t === 'pong') {
        this.latency = Math.round(performance.now() - msg.ts);
        this.dispatchEvent(new CustomEvent('latency', { detail: this.latency }));
        return;
      } else if (msg.t === 'denied') {
        this.wantOpen = false;
      }

      this.dispatchEvent(new CustomEvent('message', { detail: msg }));
      this.dispatchEvent(new CustomEvent(msg.t, { detail: msg }));
    };

    ws.onclose = () => {
      clearInterval(this.pingTimer);
      this.ws = null;
      this.selfId = null;
      if (this.wantOpen) {
        this.setState('offline');
        this.scheduleRetry();
      } else {
        this.setState('idle');
      }
    };

    ws.onerror = () => {
      /* close follows, retry is handled there */
    };
  }

  scheduleRetry() {
    clearTimeout(this.retryTimer);
    // 0.4s, 0.8s, 1.6s … capped at 6s, with jitter so a room full of clients
    // reconnecting after a server restart does not arrive in lockstep.
    const wait = Math.min(6000, 400 * 2 ** this.attempts++) * (0.75 + Math.random() * 0.5);
    this.retryTimer = setTimeout(() => this.wantOpen && this.open(), wait);
  }

  startPings() {
    clearInterval(this.pingTimer);
    this.pingTimer = setInterval(() => {
      this.send({ t: 'ping', ts: performance.now() });
    }, 5000);
  }

  setState(state) {
    if (this.state === state) return;
    this.state = state;
    this.dispatchEvent(new CustomEvent('state', { detail: state }));
  }

  send(msg) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
      return true;
    }
    // Signalling is only meaningful live; state-ish messages can wait briefly.
    if (msg.t !== 'signal' && this.queue.length < 40) this.queue.push(msg);
    return false;
  }

  flush() {
    const pending = this.queue.splice(0);
    for (const msg of pending) this.send(msg);
  }

  close() {
    this.wantOpen = false;
    clearInterval(this.pingTimer);
    clearTimeout(this.retryTimer);
    this.ws?.close();
  }
}
