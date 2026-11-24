// WebSocket connection to the Ktor backend: ws(s)://<host>/ludo/{roomId}?name=<name>
// Handles Render free-tier cold starts by retrying while the server wakes up.

const MAX_ATTEMPTS = 8;
const ATTEMPT_TIMEOUT_MS = 20000;
const RETRY_DELAY_MS = 2500;

export class Connection {
  /**
   * @param {object} o
   * @param {string} o.baseUrl   e.g. wss://airplaneludo-backend.onrender.com/ludo
   * @param {(pkt:object)=>void} o.onPacket
   * @param {(info:{code:number,reason:string,wasOpen:boolean,intentional:boolean})=>void} o.onClose
   * @param {(status:{state:string,attempt:number,max:number})=>void} [o.onStatus]
   */
  constructor({ baseUrl, onPacket, onClose, onStatus }) {
    this.baseUrl = baseUrl;
    this.onPacket = onPacket;
    this.onClose = onClose;
    this.onStatus = onStatus || (() => {});
    this.ws = null;
    this.intentional = false;
    this.opened = false;
    this.attempt = 0;
    this.timer = null;
    this.retryTimer = null;
    this.roomId = null;
    this.name = '';
    this.finished = false;
  }

  connect(roomId, name) {
    this.roomId = roomId;
    this.name = name || '';
    this.intentional = false;
    this.finished = false;
    this.attempt = 0;
    this._open();
  }

  _url() {
    const qs = this.name ? `?name=${encodeURIComponent(this.name)}` : '';
    return `${this.baseUrl}/${this.roomId}${qs}`;
  }

  _open() {
    this.attempt += 1;
    this.opened = false;
    this.onStatus({ state: this.attempt === 1 ? 'connecting' : 'waking', attempt: this.attempt, max: MAX_ATTEMPTS });
    let ws;
    try {
      ws = new WebSocket(this._url());
    } catch (e) {
      this._failBeforeOpen(e);
      return;
    }
    this.ws = ws;
    this.timer = setTimeout(() => {
      // Server did not answer in time (probably still booting) -> abandon this attempt.
      if (!this.opened && this.ws === ws) {
        ws.onclose = null; ws.onerror = null; ws.onmessage = null;
        try { ws.close(); } catch (e) { /* ignore */ }
        this._failBeforeOpen();
      }
    }, ATTEMPT_TIMEOUT_MS);

    ws.onopen = () => {
      clearTimeout(this.timer);
      this.opened = true;
      this.onStatus({ state: 'open', attempt: this.attempt, max: MAX_ATTEMPTS });
    };
    ws.onmessage = (ev) => {
      let pkt;
      try { pkt = JSON.parse(ev.data); } catch (e) { return; }
      this.onPacket(pkt);
    };
    ws.onerror = () => { /* details are not exposed by browsers; onclose follows */ };
    ws.onclose = (ev) => {
      clearTimeout(this.timer);
      if (this.ws !== ws) return;
      if (!this.opened && !this.intentional) { this._failBeforeOpen(); return; }
      this._finish({ code: ev.code, reason: ev.reason || '', wasOpen: this.opened, intentional: this.intentional });
    };
  }

  _failBeforeOpen() {
    clearTimeout(this.timer);
    if (this.intentional) return;
    if (this.attempt >= MAX_ATTEMPTS) {
      this._finish({ code: 1006, reason: '', wasOpen: false, intentional: false });
      return;
    }
    this.onStatus({ state: 'waking', attempt: this.attempt + 1, max: MAX_ATTEMPTS });
    this.retryTimer = setTimeout(() => { if (!this.intentional) this._open(); }, RETRY_DELAY_MS);
  }

  _finish(info) {
    if (this.finished) return;
    this.finished = true;
    this.ws = null;
    this.onClose(info);
  }

  get isOpen() { return !!this.ws && this.ws.readyState === WebSocket.OPEN; }

  /** Sends a GamePackets-shaped object. The server decodes strictly, so only known keys may be sent. */
  send(packet) {
    if (!this.isOpen) return false;
    this.ws.send(JSON.stringify(packet));
    return true;
  }

  close() {
    this.intentional = true;
    this.finished = true;
    clearTimeout(this.timer);
    clearTimeout(this.retryTimer);
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      ws.onclose = null; ws.onmessage = null; ws.onerror = null;
      try { ws.close(1000, 'Player left room'); } catch (e) { /* ignore */ }
    }
  }
}
