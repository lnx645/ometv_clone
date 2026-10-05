import type { SignalPayload } from '../../server/protocol.ts';

/**
 * STUN only reaches a peer's public address. Two strangers behind symmetric
 * NATs or restrictive firewalls will fail to connect without a TURN relay,
 * which is why the ICE server list is configurable.
 */
const DEFAULT_ICE_SERVERS: RTCIceServer[] = [{ urls: 'stun:stun.l.google.com:19302' }];

export function iceServers(): RTCIceServer[] {
  const stunUrls = import.meta.env.VITE_STUN_URLS?.trim();
  const servers: RTCIceServer[] = stunUrls
    ? stunUrls
        .split(',')
        .map((url) => url.trim())
        .filter(Boolean)
        .map((url) => ({ urls: url }))
    : DEFAULT_ICE_SERVERS;

  const turnUrl = import.meta.env.VITE_TURN_URL?.trim();
  const turnUser = import.meta.env.VITE_TURN_USERNAME?.trim();
  const turnCredential = import.meta.env.VITE_TURN_CREDENTIAL?.trim();
  if (turnUrl && turnUser && turnCredential) {
    servers.push({ urls: turnUrl, username: turnUser, credential: turnCredential });
  }
  return servers;
}

export type PeerEvents = {
  onLocalStream: (stream: MediaStream) => void;
  onRemoteStream: (stream: MediaStream) => void;
  /** Media can no longer flow; the caller should offer "next". */
  onClosed: () => void;
};

/**
 * One 1:1 WebRTC session.
 *
 * The server relays only SDP and ICE between two peers. Media flows directly
 * between browsers and never passes through the Function.
 */
export class PeerSession {
  #pc: RTCPeerConnection;
  #events: PeerEvents;
  #onSignal: (payload: SignalPayload) => void = () => {};
  #localStream: MediaStream | null = null;
  #closed = false;

  constructor(events: PeerEvents) {
    this.#events = events;
    this.#pc = new RTCPeerConnection({ iceServers: iceServers() });

    this.#pc.ontrack = ({ streams }) => {
      const [stream] = streams;
      if (stream && !this.#closed) this.#events.onRemoteStream(stream);
    };

    this.#pc.onicecandidate = ({ candidate }) => {
      if (!candidate || this.#closed) return;
      this.#onSignal({ kind: 'candidate', candidate: candidate.toJSON() });
    };

    this.#pc.onconnectionstatechange = () => {
      if (this.#closed) return;
      const state = this.#pc.connectionState;
      if (state === 'failed' || state === 'closed') {
        this.#events.onClosed();
      }
    };
  }

  /**
   * Attach local tracks. When `initiator` is true this sends the offer,
   * which is what starts negotiation for the pair.
   */
  async start(stream: MediaStream, initiator: boolean, onSignal: (p: SignalPayload) => void): Promise<void> {
    this.#onSignal = onSignal;
    this.#localStream = stream;
    for (const track of stream.getTracks()) {
      this.#pc.addTrack(track, stream);
    }
    this.#events.onLocalStream(stream);

    if (!initiator) return;
    const offer = await this.#pc.createOffer();
    await this.#pc.setLocalDescription(offer);
    this.#onSignal({ kind: 'offer', sdp: offer.sdp ?? '' });
  }

  /** Apply a relayed payload from the partner. */
  async handleSignal(payload: SignalPayload): Promise<void> {
    if (this.#closed) return;
    try {
      if (payload.kind === 'candidate') {
        await this.#pc.addIceCandidate(payload.candidate ?? undefined);
        return;
      }
      await this.#pc.setRemoteDescription({ type: payload.kind, sdp: payload.sdp });
      if (payload.kind === 'offer') {
        const answer = await this.#pc.createAnswer();
        await this.#pc.setLocalDescription(answer);
        this.#onSignal({ kind: 'answer', sdp: answer.sdp ?? '' });
      }
    } catch (error) {
      // ICE candidates can outlive a socket; a dropped one is not fatal.
      console.warn('signal handling failed', error);
    }
  }

  /** Toggle audio or video on the outbound tracks. */
  setTrackEnabled(kind: 'audio' | 'video', enabled: boolean): void {
    const tracks = kind === 'audio' ? this.#localStream?.getAudioTracks() : this.#localStream?.getVideoTracks();
    for (const track of tracks ?? []) {
      track.enabled = enabled;
    }
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#pc.ontrack = null;
    this.#pc.onicecandidate = null;
    this.#pc.onconnectionstatechange = null;
    for (const sender of this.#pc.getSenders()) {
      try {
        this.#pc.removeTrack(sender);
      } catch {
        /* already detached */
      }
    }
    this.#pc.close();
  }
}