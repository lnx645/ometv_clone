import { REMATCH_COOLDOWN_MS, type ServerMessage } from './protocol.ts';

/** The subset of a connected socket the matchmaker needs. */
export interface Peer {
  readonly id: string;
  /** Current 1:1 partner, or null while waiting. */
  partnerId: string | null;
  send(message: ServerMessage): void;
}

const pairKey = (a: string, b: string) => (a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`);

/**
 * FIFO queue that pairs strangers two at a time, in-process.
 *
 * This is correct for local development only. On Vercel each WebSocket
 * connection is pinned to one Function instance and no two instances share
 * memory, so a peer waiting in instance A is invisible to a peer landing in
 * instance B. Swapping this for a Redis-backed implementation is the single
 * change required to deploy — see README.md.
 */
export class InMemoryMatchmaker {
  #peers = new Map<string, Peer>();
  #queue: string[] = [];
  /** pairKey -> timestamp at which the pair becomes eligible again */
  #recent = new Map<string, number>();

  add(peer: Peer): void {
    this.#peers.set(peer.id, peer);
  }

  get(id: string): Peer | null {
    return this.#peers.get(id) ?? null;
  }

  /** Drop a peer entirely. Returns the partner it was paired with, if any. */
  remove(id: string): Peer | null {
    const partner = this.unlink(id);
    this.dequeue(id);
    this.#peers.delete(id);
    return partner;
  }

  /** Detach a peer from its partner without deleting the peer. */
  unlink(id: string): Peer | null {
    const peer = this.#peers.get(id);
    if (!peer?.partnerId) return null;
    const partner = this.#peers.get(peer.partnerId) ?? null;
    if (partner) partner.partnerId = null;
    peer.partnerId = null;
    return partner;
  }

  partnerOf(id: string): Peer | null {
    const peer = this.#peers.get(id);
    if (!peer?.partnerId) return null;
    return this.#peers.get(peer.partnerId) ?? null;
  }

  enqueue(id: string): void {
    this.dequeue(id);
    this.#queue.push(id);
  }

  dequeue(id: string): void {
    const index = this.#queue.indexOf(id);
    if (index !== -1) this.#queue.splice(index, 1);
  }

  isQueued(id: string): boolean {
    return this.#queue.includes(id);
  }

  waitingCount(): number {
    return this.#queue.length;
  }

  /** 1-based position in the queue, for the client's "you're #N" display. */
  positionOf(id: string): number {
    const index = this.#queue.indexOf(id);
    return index === -1 ? 0 : index + 1;
  }

  /**
   * Pop the first eligible pair from the queue and link them together.
   * Returns null when no two waiting peers may be paired right now.
   */
  takePair(now = Date.now()): [Peer, Peer] | null {
    // Drop ids whose socket is gone, so the queue cannot hand out ghosts.
    const queue = this.#queue.filter((id) => this.#peers.has(id));
    this.#queue = queue;

    for (let i = 0; i < queue.length; i++) {
      for (let j = i + 1; j < queue.length; j++) {
        const a = this.#peers.get(queue[i] as string);
        const b = this.#peers.get(queue[j] as string);
        if (!a || !b) continue;
        // Skip someone who just skipped you, so they are not paired again.
        if (this.#isRecent(a.id, b.id, now)) continue;

        this.dequeue(a.id);
        this.dequeue(b.id);
        a.partnerId = b.id;
        b.partnerId = a.id;
        this.#recent.set(pairKey(a.id, b.id), now + REMATCH_COOLDOWN_MS);
        return [a, b];
      }
    }
    return null;
  }

  /** Periodic housekeeping so the cooldown map cannot grow without bound. */
  prune(now = Date.now()): void {
    for (const [key, until] of this.#recent) {
      if (until <= now) this.#recent.delete(key);
    }
  }

  #isRecent(a: string, b: string, now: number): boolean {
    const until = this.#recent.get(pairKey(a, b));
    return until !== undefined && until > now;
  }
}