import type { ServerMessage } from '../../server/protocol.ts';

/** One-line description of the signaling transport for debugging. */
export const SIGNALING_PATH = '/api/ws';

export function signalingUrl(origin: string = window.location.origin): string {
  const url = new URL(SIGNALING_PATH, origin);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.toString();
}

type Listener = (message: ServerMessage) => void;
type StatusListener = (status: Status) => void;
export type Status = 'connecting' | 'open' | 'closed';

/**
 * WebSocket wrapper that reconnects with exponential backoff.
 *
 * Vercel closes every WebSocket at the function's maxDuration (300s on Hobby),
 * so a reconnect loop is mandatory rather than defensive.
 */
export class SignalingClient {
  #socket: WebSocket | null = null;
  #listeners = new Set<Listener>();
  #statusListeners = new Set<StatusListener>();
  #queue: ServerMessage[] = [];
  #delay = 1000;
  #closed = false;
  #url: string;

  constructor(url: string = signalingUrl()) {
    this.#url = url;
  }

  get status(): Status {
    if (this.#closed) return 'closed';
    switch (this.#socket?.readyState) {
      case WebSocket.OPEN:
        return 'open';
      case WebSocket.CONNECTING:
        return 'connecting';
      default:
        return 'closed';
    }
  }

  connect(): void {
    this.#closed = false;
    this.#emitStatus();

    const socket = new WebSocket(this.#url);
    this.#socket = socket;

    socket.addEventListener('open', () => {
      this.#delay = 1000;
      this.#emitStatus();
      for (const message of this.#queue.splice(0)) {
        socket.send(JSON.stringify(message));
      }
    });

    socket.addEventListener('message', (event) => {
      let message: ServerMessage;
      try {
        message = JSON.parse(String(event.data)) as ServerMessage;
      } catch {
        return;
      }
      for (const listener of this.#listeners) listener(message);
    });

    socket.addEventListener('close', () => {
      this.#emitStatus();
      if (this.#closed) return;
      const wait = this.#delay;
      this.#delay = Math.min(this.#delay * 2, 30_000);
      setTimeout(() => this.connect(), wait);
    });

    socket.addEventListener('error', () => {
      socket.close();
    });
  }

  close(): void {
    this.#closed = true;
    this.#queue.length = 0;
    this.#socket?.close();
    this.#socket = null;
    this.#emitStatus();
  }

  /** Queue the frame if the socket is not open yet. */
  send(message: ServerMessage): void {
    if (this.#socket?.readyState === WebSocket.OPEN) {
      this.#socket.send(JSON.stringify(message));
    } else {
      this.#queue.push(message);
    }
  }

  onMessage(listener: Listener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  onStatus(listener: StatusListener): () => void {
    this.#statusListeners.add(listener);
    listener(this.status);
    return () => this.#statusListeners.delete(listener);
  }

  #emitStatus(): void {
    const status = this.status;
    for (const listener of this.#statusListeners) listener(status);
  }
}