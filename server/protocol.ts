/**
 * Wire protocol for the signaling server.
 *
 * Signaling is deliberately tiny: the server only pairs two strangers and
 * relays opaque payloads between them. Everything else (SDP negotiation,
 * ICE, media) happens peer-to-peer and never touches this process.
 */

/** SDP/ICE payloads relayed verbatim from one peer to the other. */
export type SignalPayload =
  | { kind: 'offer'; sdp: string }
  | { kind: 'answer'; sdp: string }
  | { kind: 'candidate'; candidate: RTCIceCandidateInit | null };

export type ClientMessage =
  /** Enter the matchmaking queue. */
  | { type: 'join' }
  /** Leave the current partner and re-enter the queue. */
  | { type: 'next' }
  /** Relay a WebRTC negotiation payload to the current partner. */
  | { type: 'signal'; payload: SignalPayload }
  /** Relay a text chat line to the current partner. */
  | { type: 'chat'; text: string };

export type ServerMessage =
  /** Sent on connect and whenever the peer is idle but not yet paired. */
  | { type: 'waiting'; peerId: string; position: number }
  /** Paired with a stranger. `initiator` makes the first offer. */
  | { type: 'matched'; partnerId: string; initiator: boolean }
  /** The partner skipped, disconnected, or their instance shut down. */
  | { type: 'partner-left'; reason: 'next' | 'disconnected' }
  | { type: 'signal'; payload: SignalPayload }
  | { type: 'chat'; text: string }
  | { type: 'error'; message: string };

/** Longest chat line we will relay. */
export const MAX_CHAT_LENGTH = 2000;

/** How long a pair stays on the "don't rematch" list, in ms. */
export const REMATCH_COOLDOWN_MS = 5 * 60_000;

/** Parse an inbound frame, returning null when it is not a valid message. */
export function parseClientMessage(raw: string): ClientMessage | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null || !('type' in value)) {
    return null;
  }
  return value as ClientMessage;
}