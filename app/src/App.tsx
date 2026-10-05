import { useCallback, useEffect, useRef, useState } from 'react';
import { PeerSession } from './rtc.ts';
import { SignalingClient, type Status } from './signaling.ts';

type Phase =
  | { kind: 'idle' }
  | { kind: 'searching'; position: number }
  | { kind: 'connected'; partnerId: string };

type ChatLine = { from: 'me' | 'them'; text: string };

/** How many chat lines to keep before dropping the oldest. */
const CHAT_HISTORY = 50;

export default function App() {
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const [status, setStatus] = useState<Status>('closed');
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);
  const [micOn, setMicOn] = useState(true);
  const [camOn, setCamOn] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatLine[]>([]);
  const [draft, setDraft] = useState('');

  const signaling = useRef<SignalingClient | null>(null);
  const peer = useRef<PeerSession | null>(null);
  const localRef = useRef<MediaStream | null>(null);
  const localVideo = useRef<HTMLVideoElement>(null);
  const remoteVideo = useRef<HTMLVideoElement>(null);

  /** Tear down the current 1:1 session without touching the signaling socket. */
  const endPeer = useCallback(() => {
    peer.current?.close();
    peer.current = null;
    setRemoteStream(null);
    setPhase({ kind: 'idle' });
  }, []);

  const startPeer = useCallback(async (initiator: boolean, partnerId: string) => {
    let stream = localRef.current;
    if (!stream) {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { width: { ideal: 1280 }, height: { ideal: 720 } },
          audio: { echoCancellation: true, noiseSuppression: true },
        });
      } catch (err) {
        setError(
          err instanceof DOMException && err.name === 'NotAllowedError'
            ? 'Camera and microphone permission denied.'
            : 'Could not open your camera or microphone.',
        );
        return;
      }
      localRef.current = stream;
      setLocalStream(stream);
    }

    endPeer();
    const session = new PeerSession({
      onLocalStream: setLocalStream,
      onRemoteStream: setRemoteStream,
      onClosed: endPeer,
    });
    peer.current = session;
    setPhase({ kind: 'connected', partnerId });
    // A new stranger means a fresh transcript.
    setMessages([]);
    await session.start(stream, initiator, (payload) => signaling.current?.send({ type: 'signal', payload }));
  }, [endPeer]);

  // One SignalingClient for the whole mount. StrictMode double-invokes effects
  // in dev, so teardown must close exactly the socket it opened.
  useEffect(() => {
    const client = new SignalingClient();
    signaling.current = client;
    const offStatus = client.onStatus(setStatus);
    const offMessage = client.onMessage((message) => {
      switch (message.type) {
        case 'waiting':
          setPhase((prev) => (prev.kind === 'connected' ? prev : { kind: 'searching', position: message.position }));
          break;
        case 'chat':
          setMessages((prev) => [...prev.slice(-(CHAT_HISTORY - 1)), { from: 'them', text: message.text }]);
          break;
        case 'matched':
          void startPeer(message.initiator, message.partnerId);
          break;
        case 'partner-left':
          endPeer();
          break;
        case 'signal':
          void peer.current?.handleSignal(message.payload);
          break;
        case 'error':
          setError(message.message);
          break;
      }
    });
    client.connect();
    return () => {
      offStatus();
      offMessage();
      client.close();
      signaling.current = null;
    };
  }, [startPeer, endPeer]);

  // Video elements exist on first render, so assign srcObject after mount.
  useEffect(() => {
    if (localVideo.current && localStream) {
      localVideo.current.srcObject = localStream;
    }
  }, [localStream]);

  useEffect(() => {
    if (remoteVideo.current && remoteStream) {
      remoteVideo.current.srcObject = remoteStream;
    }
  }, [remoteStream]);

  useEffect(
    () => () => {
      for (const track of localRef.current?.getTracks() ?? []) track.stop();
    },
    [],
  );

  const findPartner = () => {
    setError(null);
    endPeer();
    signaling.current?.send({ type: 'join' });
  };

  const skipPartner = () => {
    endPeer();
    signaling.current?.send({ type: 'next' });
  };

  const toggleMic = () => {
    const next = !micOn;
    setMicOn(next);
    peer.current?.setTrackEnabled('audio', next);
  };

  const toggleCam = () => {
    const next = !camOn;
    setCamOn(next);
    peer.current?.setTrackEnabled('video', next);
  };

  const sendChat = (event: React.FormEvent) => {
    event.preventDefault();
    const text = draft.trim();
    if (!text) return;
    signaling.current?.send({ type: 'chat', text });
    setMessages((prev) => [...prev.slice(-(CHAT_HISTORY - 1)), { from: 'me', text }]);
    setDraft('');
  };

  const connected = phase.kind === 'connected';

  return (
    <main className="app">
      <header className="bar">
        <h1>ome tv clone</h1>
        <span className={`status status--${status}`}>{status}</span>
      </header>

      <section className="stage">
        <video ref={remoteVideo} className="video video--remote" autoPlay playsInline />
        {!remoteStream && (
          <div className="overlay">
            {phase.kind === 'searching' && phase.position > 1
              ? `Finding someone… you are #${phase.position}`
              : 'Finding someone…'}
          </div>
        )}
        <video ref={localVideo} className="video video--local" autoPlay playsInline muted />
      </section>

      <section className="chat" aria-label="Chat">
        <ol className="chat__log">
          {messages.map((line, index) => (
            <li key={index} className={`chat__line chat__line--${line.from}`}>
              {line.text}
            </li>
          ))}
        </ol>
        <form className="chat__form" onSubmit={sendChat}>
          <input
            className="chat__input"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder={connected ? 'Say something' : 'Matched to start chatting'}
            disabled={!connected}
            maxLength={2000}
            aria-label="Message"
          />
          <button type="submit" className="btn" disabled={!connected || !draft.trim()}>
            Send
          </button>
        </form>
      </section>

      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}

      <section className="controls">
        {connected ? (
          <button type="button" className="btn btn--primary" onClick={skipPartner}>
            Next
          </button>
        ) : (
          <button
            type="button"
            className="btn btn--primary"
            onClick={findPartner}
            disabled={status !== 'open'}
          >
            Start
          </button>
        )}
        <button type="button" className="btn" onClick={toggleMic} disabled={!connected}>
          {micOn ? 'Mute' : 'Unmute'}
        </button>
        <button type="button" className="btn" onClick={toggleCam} disabled={!connected}>
          {camOn ? 'Camera off' : 'Camera on'}
        </button>
      </section>
    </main>
  );
}