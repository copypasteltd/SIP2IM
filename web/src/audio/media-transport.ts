import {
  decodeMediaFrame,
  encodeMediaFrame,
  MEDIA_FLAGS,
  MEDIA_HEADER_BYTES,
  nextSequence,
} from '../../../packages/protocol/src/media';

export type MediaFlags = { earlyMedia: boolean; prompt: boolean };

const FRAME_SAMPLES = 320;
const PCM_BYTES = FRAME_SAMPLES * Int16Array.BYTES_PER_ELEMENT;
const FRAME_BYTES = MEDIA_HEADER_BYTES + PCM_BYTES;
// Cap application bytes reported by bufferedAmount at PCM admission. An empty queue fits
// six 20 ms frames. WebSocket framing and lower-layer queues are outside this count.
const MAX_BUFFERED_BYTES = 4 * 1024;

export function openMediaTransport(
  path: string,
  token: string,
  onAudio: (samples: Float32Array, flags: MediaFlags) => void,
  onClose: () => void,
) {
  const configured = import.meta.env.VITE_API_BASE as string | undefined;
  const base = new URL(configured || window.location.origin);
  const url = new URL(path, base);
  if (
    url.origin !== base.origin || url.pathname !== '/ws/media' ||
    url.searchParams.has('token') || url.username || url.password || url.hash
  ) {
    throw new Error('Invalid media path');
  }
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  const socket = new WebSocket(url.toString());
  socket.binaryType = 'arraybuffer';
  let seq = 0;
  let authSent = false;
  let stopped = false;
  const isOpen = () => !stopped && socket.readyState === WebSocket.OPEN;

  function stop(notifyLoss: boolean) {
    if (stopped) return;
    stopped = true;
    socket.onopen = null;
    socket.onmessage = null;
    socket.onerror = null;
    socket.onclose = null;
    if (socket.readyState < WebSocket.CLOSING) {
      try { socket.close(); } catch { /* Still release the caller's local audio on loss. */ }
    }
    if (notifyLoss) onClose();
  }

  function sendAuth() {
    if (!isOpen() || socket.onopen !== sendAuth) return;
    socket.onopen = null;
    try {
      socket.send(JSON.stringify({ type: 'auth', token }));
      // Core processes auth first on this ordered socket and sends no auth ACK.
      authSent = true;
    } catch { stop(true); }
  }
  socket.onopen = sendAuth;
  socket.onmessage = (event: MessageEvent<unknown>) => {
    if (!authSent || !isOpen() || !(event.data instanceof ArrayBuffer)) return;
    try {
      const frame = decodeMediaFrame(new Uint8Array(event.data));
      if (frame.format !== 2) return;
      const samples = new Float32Array(FRAME_SAMPLES);
      if (!(frame.flags & MEDIA_FLAGS.silence)) {
        const view = new DataView(frame.pcm.buffer, frame.pcm.byteOffset, frame.pcm.byteLength);
        for (let i = 0; i < FRAME_SAMPLES; i++) samples[i] = view.getInt16(i * 2, true) / 32768;
      }
      onAudio(samples, {
        earlyMedia: !!(frame.flags & MEDIA_FLAGS.earlyMedia),
        prompt: !!(frame.flags & MEDIA_FLAGS.prompt),
      });
    } catch { /* Ignore malformed media or a failed playback callback. */ }
  };
  const lost = () => stop(true);
  socket.onerror = lost;
  socket.onclose = lost;

  return {
    send(samples: Float32Array) {
      if (!authSent || !isOpen() || samples.length !== FRAME_SAMPLES) return;
      // Reserve a slot even when dropping this chunk. A later frame exposes the gap to Core.
      const frameSeq = seq;
      seq = nextSequence(seq);
      if (socket.bufferedAmount + FRAME_BYTES > MAX_BUFFERED_BYTES) return;

      const pcm = new Uint8Array(PCM_BYTES);
      const view = new DataView(pcm.buffer);
      for (let i = 0; i < FRAME_SAMPLES; i++) {
        const n = Math.max(-1, Math.min(1, samples[i]));
        view.setInt16(i * 2, n < 0 ? Math.round(n * 32768) : Math.round(n * 32767), true);
      }
      const frame = encodeMediaFrame({
        format: 2, flags: 0, seq: frameSeq, captureTs: Date.now() >>> 0, pcm,
      });
      try { socket.send(frame); } catch { stop(true); }
    },
    close() { stop(false); },
  };
}
