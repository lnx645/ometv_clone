import { Hono } from 'hono';
import { upgradeWebSocket } from 'hono/bun';
import { InMemoryMatchmaker, type Peer } from './matchmaker.ts';
import { MAX_CHAT_LENGTH, parseClientMessage, type ServerMessage } from './protocol.ts';

const matchmaker = new InMemoryMatchmaker();

/**
 * Pair up as many waiting peers as possible.
 *
 * The peer that waited longer is told to make the WebRTC offer. With one
 * fixed initiator there is no glare, so the client does not need the
 * perfect-negotiation dance for the initial handshake.
 */
function attemptPair(): void {
  let pair: [Peer, Peer] | null;
  while ((pair = matchmaker.takePair())) {
    const [first, second] = pair;
    first.send({ type: 'matched', partnerId: second.id, initiator: true });
    second.send({ type: 'matched', partnerId: first.id, initiator: false });
  }
}

/** Re-queue both sides of a broken pair, then look for a fresh one. */
function reshuffle(leaverId: string, partner: Peer | null, reason: 'next' | 'disconnected'): void {
  if (partner) {
    partner.send({ type: 'partner-left', reason });
    matchmaker.enqueue(partner.id);
  }
  matchmaker.enqueue(leaverId);
  attemptPair();
}

const app = new Hono();

app.get('/api/health', (c) =>
  c.json({ ok: true, waiting: matchmaker.waitingCount(), peers: matchmaker.waitingCount() }),
);

app.get(
  '/api/ws',
  upgradeWebSocket((ws) => {
    const id = crypto.randomUUID();
    const peer: Peer = {
      id,
      partnerId: null,
      send(message: ServerMessage) {
        // A racing close() can invalidate the socket mid-send; the peer's
        // disconnect handler will do the cleanup, so swallowing is correct.
        try {
          ws.send(JSON.stringify(message));
        } catch {
          /* socket already closed */
        }
      },
    };
    matchmaker.add(peer);

    return {
      onOpen() {
        peer.send({ type: 'waiting', position: 0 });
      },

      onMessage(event) {
        const message = parseClientMessage(String(event.data));
        if (!message) {
          peer.send({ type: 'error', message: 'malformed message' });
          return;
        }

        switch (message.type) {
          case 'join': {
            if (matchmaker.partnerOf(id)) return;
            matchmaker.enqueue(id);
            attemptPair();
            // Still unpaired means the queue had nobody compatible.
            if (!matchmaker.partnerOf(id)) {
              peer.send({ type: 'waiting', position: matchmaker.positionOf(id) });
            }
            return;
          }

          case 'next': {
            if (matchmaker.partnerOf(id)) {
              reshuffle(id, matchmaker.unlink(id), 'next');
            } else {
              matchmaker.enqueue(id);
              attemptPair();
              if (!matchmaker.partnerOf(id)) {
                peer.send({ type: 'waiting', position: matchmaker.positionOf(id) });
              }
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
        // The socket is already gone, so notify before dropping the peer.
        const partner = matchmaker.remove(id);
        if (partner) reshufflePartner(partner);
      },

      onError() {
        const partner = matchmaker.remove(id);
        if (partner) reshufflePartner(partner);
      },
    };
  }),
);

/** A partner left without choosing to; put them back in the queue. */
function reshufflePartner(partner: Peer): void {
  matchmaker.enqueue(partner.id);
  partner.send({ type: 'partner-left', reason: 'disconnected' });
  attemptPair();
}

// Keep the rematch-cooldown map from growing without bound.
const pruneTimer = setInterval(() => matchmaker.prune(), 60_000);
pruneTimer.unref?.();

export { app };
export default app;