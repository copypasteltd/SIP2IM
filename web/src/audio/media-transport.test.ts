// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { decodeMediaFrame, encodeMediaFrame, MEDIA_FLAGS } from '../../../packages/protocol/src/media';
import { openMediaTransport } from './media-transport';

const mediaPath = '/ws/media?session=fixture&leg=fixture';
const mediaToken = 'fixture-token';
const frameBytes = 652;
const queueLimit = 4 * 1024;
const chunk = new Float32Array(320);
const sockets: FakeSocket[] = [];

class FakeSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readyState: number = FakeSocket.CONNECTING;
  binaryType = '';
  bufferedAmount = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;

  constructor(readonly url: string) { sockets.push(this); }

  open() {
    this.readyState = FakeSocket.OPEN;
    this.onopen?.();
  }

  send = vi.fn((data: string | Uint8Array) => {
    if (this.readyState !== FakeSocket.OPEN) throw new Error('Socket is not open');
    this.bufferedAmount += typeof data === 'string'
      ? new TextEncoder().encode(data).byteLength
      : data.byteLength;
  });

  close = vi.fn(() => {
    this.readyState = FakeSocket.CLOSED;
    this.onclose?.();
  });
}

beforeEach(() => {
  sockets.length = 0;
  vi.stubEnv('VITE_API_BASE', 'https://voip.example.test');
  vi.stubGlobal('WebSocket', FakeSocket);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

function setup() {
  const onAudio = vi.fn();
  const onClose = vi.fn();
  const transport = openMediaTransport(mediaPath, mediaToken, onAudio, onClose);
  return { transport, socket: sockets[0], onAudio, onClose };
}

function promptFrame() {
  return encodeMediaFrame({
    format: 2, flags: MEDIA_FLAGS.prompt | MEDIA_FLAGS.earlyMedia | MEDIA_FLAGS.silence,
    seq: 2, captureTs: 1, pcm: new Uint8Array(),
  }).buffer;
}

function callbacks(socket: FakeSocket) {
  return { open: socket.onopen!, message: socket.onmessage!, error: socket.onerror!, close: socket.onclose! };
}

it('queues auth first and keeps 16 kHz PCM flags and encoding', () => {
  const { transport, socket } = setup();
  expect(socket.url).toBe('wss://voip.example.test' + mediaPath);
  expect(socket.binaryType).toBe('arraybuffer');
  const lateOpen = socket.onopen!;
  transport.send(chunk);
  socket.readyState = FakeSocket.OPEN;
  transport.send(chunk);
  expect(socket.send).not.toHaveBeenCalled();

  lateOpen();
  lateOpen();
  transport.send(new Float32Array(319));
  const samples = new Float32Array(320).fill(0.5);
  samples[1] = -1.5;
  samples[2] = 1.5;
  transport.send(samples);

  expect(socket.send).toHaveBeenCalledTimes(2);
  const [[auth], [media]] = socket.send.mock.calls;
  expect(JSON.parse(auth as string)).toEqual({ type: 'auth', token: mediaToken });
  expect(media).toHaveLength(frameBytes);
  const frame = decodeMediaFrame(media as Uint8Array);
  expect(frame).toMatchObject({ format: 2, flags: 0, seq: 0 });
  const pcm = new DataView(frame.pcm.buffer);
  expect([pcm.getInt16(0, true), pcm.getInt16(2, true), pcm.getInt16(4, true)])
    .toEqual([16384, -32768, 32767]);
});

it('ignores text, malformed media, and other formats while preserving incoming flags', () => {
  const { socket, onAudio, onClose } = setup();
  socket.open();
  socket.onmessage?.({ data: '{"type":"fixture-control"}' });
  socket.onmessage?.({ data: new ArrayBuffer(1) });
  socket.onmessage?.({ data: encodeMediaFrame({
    format: 1, flags: MEDIA_FLAGS.silence, seq: 1, captureTs: 1, pcm: new Uint8Array(),
  }).buffer });
  expect(onAudio).not.toHaveBeenCalled();
  expect(onClose).not.toHaveBeenCalled();
  socket.onmessage?.({ data: promptFrame() });
  expect(onAudio).toHaveBeenCalledExactlyOnceWith(chunk, { earlyMedia: true, prompt: true });
});

it('accepts exactly 4 KiB and drops new chunks above it without replay', () => {
  const { transport, socket, onClose } = setup();
  socket.open();
  socket.bufferedAmount = queueLimit - frameBytes;
  transport.send(chunk);
  expect(socket.bufferedAmount).toBe(queueLimit);
  transport.send(new Float32Array(320).fill(-0.25));
  socket.bufferedAmount = queueLimit - frameBytes + 1;
  transport.send(new Float32Array(320).fill(-0.5));
  expect(socket.send).toHaveBeenCalledTimes(2);
  expect(socket.bufferedAmount).toBe(queueLimit - frameBytes + 1);
  expect(onClose).not.toHaveBeenCalled();

  socket.bufferedAmount = 0;
  transport.send(new Float32Array(320).fill(0.25));
  expect(socket.send).toHaveBeenCalledTimes(3);
  const first = decodeMediaFrame(socket.send.mock.calls[1][0] as Uint8Array);
  const resumed = decodeMediaFrame(socket.send.mock.calls[2][0] as Uint8Array);
  expect(first.seq).toBe(0);
  expect(resumed.seq).toBe(3);
  expect(new DataView(resumed.pcm.buffer).getInt16(0, true)).toBe(8192);
});

it('bounds a stalled socket at six complete PCM messages plus the pending auth bytes', () => {
  const { transport, socket } = setup();
  socket.open();
  const authBytes = socket.bufferedAmount;
  for (let i = 0; i < 50; i++) transport.send(chunk);
  expect(socket.send).toHaveBeenCalledTimes(7);
  expect(socket.bufferedAmount).toBe(authBytes + 6 * frameBytes);
  expect(socket.bufferedAmount).toBeLessThanOrEqual(queueLimit);
});

it.each(['error', 'close'] as const)('reports socket %s only once and fences stale callbacks', event => {
  const { transport, socket, onAudio, onClose } = setup();
  const stale = callbacks(socket);
  socket.open();
  onClose.mockImplementation(() => {
    transport.send(chunk);
    transport.close();
  });

  if (event === 'close') {
    socket.readyState = FakeSocket.CLOSING;
    transport.send(chunk);
    socket.readyState = FakeSocket.CLOSED;
  }
  stale[event]();
  stale.open();
  stale.message({ data: promptFrame() });
  stale.error();
  stale.close();
  transport.close();

  expect(onClose).toHaveBeenCalledOnce();
  expect(onAudio).not.toHaveBeenCalled();
  expect(socket.send).toHaveBeenCalledTimes(1);
  expect(socket.close).toHaveBeenCalledTimes(event === 'error' ? 1 : 0);
  expect([socket.onopen, socket.onmessage, socket.onerror, socket.onclose]).toEqual([
    null, null, null, null,
  ]);
  expect(sockets).toHaveLength(1);
});

it.each(['auth', 'PCM'] as const)('reports a failed %s send even when socket close throws', operation => {
  const { transport, socket, onAudio, onClose } = setup();
  const stale = callbacks(socket);
  if (operation === 'PCM') socket.open();
  socket.send.mockImplementationOnce(() => { throw new Error('send failed'); });
  socket.close.mockImplementationOnce(() => { throw new Error('close failed'); });
  if (operation === 'auth') socket.open();
  else transport.send(chunk);

  expect(onClose).toHaveBeenCalledOnce();
  expect(socket.readyState).toBe(FakeSocket.OPEN);
  transport.send(chunk);
  stale.open();
  stale.message({ data: promptFrame() });
  stale.error();
  stale.close();
  transport.close();
  expect(onAudio).not.toHaveBeenCalled();
  expect(onClose).toHaveBeenCalledOnce();
  expect(socket.send).toHaveBeenCalledTimes(operation === 'auth' ? 1 : 2);
  expect(socket.close).toHaveBeenCalledOnce();
});

it('keeps explicit close silent even if closing fails and callbacks arrive late', () => {
  const { transport, socket, onAudio, onClose } = setup();
  const stale = callbacks(socket);
  socket.close.mockImplementationOnce(() => {
    stale.close();
    throw new Error('close failed');
  });
  transport.close();
  socket.readyState = FakeSocket.OPEN;
  stale.open();
  stale.error();
  stale.message({ data: promptFrame() });
  transport.send(chunk);
  transport.close();

  expect(socket.close).toHaveBeenCalledOnce();
  expect(socket.send).not.toHaveBeenCalled();
  expect(onAudio).not.toHaveBeenCalled();
  expect(onClose).not.toHaveBeenCalled();
});

it('rejects invalid media paths without constructing a socket', () => {
  for (const path of [
    'https://outside.example.test/ws/media', '/ws/admin', '/ws/media?token=fixture',
    'https://user@voip.example.test/ws/media', '/ws/media#fragment',
  ]) expect(() => openMediaTransport(path, mediaToken, vi.fn(), vi.fn())).toThrow('Invalid media path');
  expect(sockets).toHaveLength(0);
});
