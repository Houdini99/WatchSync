// A thin reconnecting WebSocket wrapper with a typed pub/sub layer.
//
// Native WebSocket has no auto-reconnect, so we add exponential backoff and
// re-fire an `open` event on every (re)connection — the client re-sends
// `join_room` each time, and the server's stable-clientId seat reclaim makes
// the reconnect seamless.

import type { ClientMsg, ServerMsg } from '../types';

type MsgType = ServerMsg['type'];
type Handler = (msg: ServerMsg) => void;
type StatusHandler = (connected: boolean) => void;

export class Socket {
  private ws: WebSocket | null = null;
  private readonly url: string;
  private readonly handlers = new Map<MsgType, Set<Handler>>();
  private readonly statusHandlers = new Set<StatusHandler>();
  private shouldRun = false;
  private backoff = 500;
  private reconnectTimer: number | null = null;

  constructor() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    this.url = `${proto}//${location.host}/ws`;
  }

  connect() {
    this.shouldRun = true;
    this.open();
  }

  private open() {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return;
    }
    const ws = new WebSocket(this.url);
    this.ws = ws;

    ws.onopen = () => {
      this.backoff = 500;
      this.emitStatus(true);
    };
    ws.onclose = () => {
      this.emitStatus(false);
      this.scheduleReconnect();
    };
    ws.onerror = () => {
      // `onclose` will follow and drive the reconnect.
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    };
    ws.onmessage = (ev) => {
      let msg: ServerMsg;
      try {
        msg = JSON.parse(ev.data as string) as ServerMsg;
      } catch {
        return;
      }
      this.handlers.get(msg.type)?.forEach((h) => h(msg));
    };
  }

  private scheduleReconnect() {
    if (!this.shouldRun || this.reconnectTimer !== null) return;
    const delay = this.backoff;
    this.backoff = Math.min(this.backoff * 1.7, 8000);
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      if (this.shouldRun) this.open();
    }, delay);
  }

  /** Subscribe to a server message type. Returns an unsubscribe function. */
  on<T extends MsgType>(type: T, handler: (msg: Extract<ServerMsg, { type: T }>) => void): () => void {
    let set = this.handlers.get(type);
    if (!set) {
      set = new Set();
      this.handlers.set(type, set);
    }
    set.add(handler as Handler);
    return () => set!.delete(handler as Handler);
  }

  onStatus(handler: StatusHandler): () => void {
    this.statusHandlers.add(handler);
    return () => this.statusHandlers.delete(handler);
  }

  private emitStatus(connected: boolean) {
    this.statusHandlers.forEach((h) => h(connected));
  }

  /**
   * Send if the socket is open. Returns `false` when the message was dropped —
   * callers that show success UI (a toast, clearing an input) must check it,
   * or during the 0.5–8s reconnect backoff the user gets "Added to queue" for
   * something that never left the browser.
   */
  send(msg: ClientMsg): boolean {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
      return true;
    }
    return false;
  }

  get isOpen() {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  close() {
    this.shouldRun = false;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const ws = this.ws;
    this.ws = null;
    if (!ws) return;
    // Detach BEFORE closing. `close()` is async: onclose used to fire a tick
    // later on the socket we had already discarded, calling emitStatus(false)
    // and scheduleReconnect(). That overwrote real errors — a join_error
    // ("Room not found") was replaced on the landing page by "Disconnected —
    // reconnecting…" when nothing was reconnecting — and, after a deliberate
    // reconnect, flipped `connected` back to false on the NEW open socket.
    ws.onopen = null;
    ws.onclose = null;
    ws.onerror = null;
    ws.onmessage = null;
    try {
      ws.close();
    } catch {
      /* ignore */
    }
    // Deliberately NO emitStatus(false) here. A caller-initiated close is not
    // "the connection dropped", and the status handler renders the disconnect
    // path as "Disconnected — reconnecting…" — which would clobber the very
    // message (join_error, kicked) that prompted the close in the first place.
  }
}
