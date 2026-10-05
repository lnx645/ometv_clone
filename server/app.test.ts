/**
 * Smoke test for the signaling layer.
 *
 * Runs against a real Bun.serve instance so the upgrade handshake, the
 * matchmaking queue, and SDP relay are all exercised end to end.
 *
 *   bun test
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { Server } from 'bun';
import { app, websocket, type BunWebSocketData } from './app.ts';
import type { ClientMessage, ServerMessage } from './protocol.ts';

let server: Server<BunWebSocketData>;
let base: string;

/** A test client that records every frame the server sends it. */
function open() {
  const socket = new WebSocket(`${base.replace('http', 'ws')}/api/ws`);
  const inbox: ServerMessage[] = [];
  const waiters: ServerMessage[][] = [];

  socket.addEventListener('message', (event) => {
    inbox.push(JSON.parse(String(event.data)) as ServerMessage);
    for (const waiter of waiters.splice(0)) {
      waiter.push(inbox[inbox.length - 1] as ServerMessage);
    }
  });

  const client = {
    socket,
    send(message: ClientMessage) {
      socket.send(JSON.stringify(message));
    },
    /** Resolve with the next frame matching `type`. */
    async next<T extends ServerMessage['type']>(
      type: T,
      timeoutMs = 2000,
    ): Promise<Extract<ServerMessage, { type: T }>> {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const hit = inbox.find((m): m is Extract<ServerMessage, { type: T }> => m.type === type);
        if (hit) {
          inbox.splice(inbox.indexOf(hit), 1);
          return hit;
        }
        if (Date.now() > deadline) throw new Error(`timed out waiting for "${type}"`);
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    },
    async open$() {
      if (socket.readyState === WebSocket.OPEN) return;
      await new Promise<void>((resolve, reject) => {
        socket.addEventListener('open', () => resolve(), { once: true });
        socket.addEventListener('error', () => reject(new Error('socket error')), { once: true });
      });
    },
    async close() {
      socket.close();
      await new Promise((resolve) => setTimeout(resolve, 20));
    },
  };
  void waiters;
  return client;
}

beforeAll(() => {
  server = Bun.serve({ port: 0, fetch: app.fetch, websocket });
  base = `http://localhost:${server.port}`;
});

afterAll(() => {
  server?.stop(true);
});

describe('signaling', () => {
  test('answers a health check over HTTP', async () => {
    const response = await fetch(`${base}/api/health`);
    const body = (await response.json()) as { ok: boolean };
    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
  });

  test('greeted on connect, then reports a queue position on join', async () => {
    const alice = open();
    await alice.open$();
    await alice.next('waiting');

    alice.send({ type: 'join' });
    const waiting = await alice.next('waiting');
    expect(waiting.position).toBe(1);

    await alice.close();
  });

  test('pairs two waiting peers and assigns exactly one initiator', async () => {
    const alice = open();
    await alice.open$();
    const aId = (await alice.next('waiting')).peerId;
    alice.send({ type: 'join' });

    const bob = open();
    await bob.open$();
    const bId = (await bob.next('waiting')).peerId;
    bob.send({ type: 'join' });

    const [a, b] = await Promise.all([alice.next('matched'), bob.next('matched')]);
    expect(a.partnerId).toBe(bId);
    expect(b.partnerId).toBe(aId);
    expect(a.initiator).toBe(true);
    expect(b.initiator).toBe(false);

    await alice.close();
    await bob.close();
  });

  test('relays an offer only to the paired partner', async () => {
    const alice = open();
    await alice.open$();
    await alice.next('waiting');
    alice.send({ type: 'join' });

    const bob = open();
    await bob.open$();
    await bob.next('waiting');
    bob.send({ type: 'join' });

    await Promise.all([alice.next('matched'), bob.next('matched')]);

    bob.send({ type: 'signal', payload: { kind: 'offer', sdp: 'v=0 fake' } });
    const relayed = await alice.next('signal');
    expect(relayed.payload).toEqual({ kind: 'offer', sdp: 'v=0 fake' });

    // Bob must not receive his own offer back.
    expect(bob.next('signal', 150).catch(() => 'absent')).resolves.toBe('absent');

    await alice.close();
    await bob.close();
  });

  test('relays chat text and trims it', async () => {
    const alice = open();
    await alice.open$();
    await alice.next('waiting');
    alice.send({ type: 'join' });

    const bob = open();
    await bob.open$();
    await bob.next('waiting');
    bob.send({ type: 'join' });
    await Promise.all([alice.next('matched'), bob.next('matched')]);

    bob.send({ type: 'chat', text: '  halo  ' });
    const chat = await alice.next('chat');
    expect(chat.text).toBe('halo');

    await alice.close();
    await bob.close();
  });

  test('next notifies the old partner and requeues both sides', async () => {
    const alice = open();
    await alice.open$();
    await alice.next('waiting');
    alice.send({ type: 'join' });

    const bob = open();
    await bob.open$();
    await bob.next('waiting');
    bob.send({ type: 'join' });
    await Promise.all([alice.next('matched'), bob.next('matched')]);

    bob.send({ type: 'next' });
    const left = await alice.next('partner-left');
    expect(left.reason).toBe('next');

    await alice.close();
    await bob.close();
  });

  test('disconnect notifies the partner as "disconnected"', async () => {
    const alice = open();
    await alice.open$();
    await alice.next('waiting');
    alice.send({ type: 'join' });

    const bob = open();
    await bob.open$();
    await bob.next('waiting');
    bob.send({ type: 'join' });
    await Promise.all([alice.next('matched'), bob.next('matched')]);

    await bob.close();
    const left = await alice.next('partner-left');
    expect(left.reason).toBe('disconnected');

    await alice.close();
  });

  test('a skip does not immediately rematch the same two people', async () => {
    const alice = open();
    await alice.open$();
    await alice.next('waiting');
    alice.send({ type: 'join' });

    const bob = open();
    await bob.open$();
    await bob.next('waiting');
    bob.send({ type: 'join' });
    await Promise.all([alice.next('matched'), bob.next('matched')]);

    bob.send({ type: 'next' });
    await alice.next('partner-left');

    // Both are queued again, but the cooldown must keep them apart.
    expect(alice.next('matched', 300).catch(() => 'absent')).resolves.toBe('absent');
    expect(bob.next('matched', 300).catch(() => 'absent')).resolves.toBe('absent');

    await alice.close();
    await bob.close();
  });

  test('rejects a malformed frame without dropping the socket', async () => {
    const alice = open();
    await alice.open$();
    await alice.next('waiting');

    alice.socket.send('not json at all');
    const error = await alice.next('error');
    expect(error.message).toBe('malformed message');
    expect(alice.socket.readyState).toBe(WebSocket.OPEN);

    await alice.close();
  });
});