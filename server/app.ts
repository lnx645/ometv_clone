import { Hono } from 'hono';
import { upgradeWebSocket, websocket, type BunWebSocketData } from '@hono/bun';
import { InMemoryMatchmaker, type Peer } from './matchmaker.ts';
import { MAX_CHAT_LENGTH, parseClientMessage, type ServerMessage } from './protocol.ts';

const matchmaker = new InMemoryMatchmaker();

/**
 * Pair up as many waiting peers as possible.
 *
 * The peer that waited longer is told to make the WebRTC offer. With one fixed
 * initiator there is no glare, so the initial handshake needs no
 * perfect-negotiation renegotiation dance.
 */
function attemptPair(): void {
  let pair: [Peer, Peer] | null;
  while ((pair = matchmaker.takePair())) {
    const [first, second] = pair;
    first.send({ type: 'matched', partnerId: second.id, initiator: true });
    second.send({ type: 'matched', partnerId: first.id, initiator: false });
  }
}

/** Put a peer whose partner vanished back into the queue. */
function requeue(partner: Peer, reason: 'next' | 'disconnected'): void {
  partner.send({ type: 'partner-left', reason });
  matchmaker.enqueue(partner.id);
  attemptPair();
}

/** Tell a peer it is searching, unless it just got paired. */
function announceQueue(id: string): void {
  if (matchmaker.partnerOf(id)) return;
  matchmaker.get(id)?.send({ type: 'waiting', peerId: id, position: matchmaker.positionOf(id) });
}

const app = new Hono();

app.get('/api/health', (c) =>
  c.json({ ok: true, waiting: matchmaker.waitingCount() }),
);

app.get(
  '/api/ws',
  upgradeWebSocket((_c) => {
    const id = crypto.randomUUID();
    const peer: Peer = {
      id,
      partnerId: null,
      ws: null,
      send(message: ServerMessage) {
        // A racing close() can invalidate the socket mid-send; the close
        // handler does the cleanup, so swallowing here is correct.
        peer.ws?.send(JSON.stringify(message));
      },
    };

    return {
      onOpen(_evt, ws) {
        peer.ws = ws;
        matchmaker.add(peer);
        // Announces this peer's own id, which the client uses as its handle.
        peer.send({ type: 'waiting', peerId: id, position: 0 });
      },

      onMessage(evt, _ws) {
        const { data } = evt;
        const raw = typeof data === 'string' ? data : new TextDecoder().decode(data as ArrayBufferLike);
        const message = parseClientMessage(raw);
        if (!message) {
          peer.send({ type: 'error', message: 'malformed message' });
          return;
        }

        switch (message.type) {
          case 'join': {
            if (matchmaker.partnerOf(id)) return;
            matchmaker.enqueue(id);
            attemptPair();
            announceQueue(id);
            return;
          }

          case 'next': {
            const partner = matchmaker.unlink(id);
            if (partner) {
              peer.send({ type: 'partner-left', reason: 'next' });
              matchmaker.enqueue(id);
              requeue(partner, 'next');
            } else {
              matchmaker.enqueue(id);
              attemptPair();
              announceQueue(id);
            }
            return;
          }

          case 'signal': {
            const partner = matchmaker.partnerOf(id);
            if (!partner) {
              peer.send({ type: 'error', message: 'not paired' });
              return;
            }
            partner.send({ type: 'signal', payload: message.payload });
            return;
          }

          case 'chat': {
            const partner = matchmaker.partnerOf(id);
            const text = typeof message.text === 'string' ? message.text.trim() : '';
            if (!partner || !text) return;
            partner.send({ type: 'chat', text: text.slice(0, MAX_CHAT_LENGTH) });
            return;
          }

          default:
            peer.send({ type: 'error', message: 'unknown message type' });
        }
      },

      onClose() {
        peer.ws = null;
        // The socket is already gone, so notify the partner before dropping it.
        const partner = matchmaker.remove(id);
        if (partner) requeue(partner, 'disconnected');
      },

      onError() {
        peer.ws = null;
        const partner = matchmaker.remove(id);
        if (partner) requeue(partner, 'disconnected');
      },
    };
  }),
);

// Keep the rematch-cooldown map from growing without bound.
const pruneTimer = setInterval(() => matchmaker.prune(), 60_000);
pruneTimer.unref?.();

export { app };
/**
 * Bun's `websocket` dispatch table. Hono stashes per-connection handlers on the
 * upgrade data, so one shared handler serves every route.
 */
export { websocket };
export type { BunWebSocketData };