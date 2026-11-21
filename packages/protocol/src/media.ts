export type MediaFormat = 1 | 2 | 3;
export const MEDIA_HEADER_BYTES = 12;
export const MEDIA_FLAGS = { earlyMedia: 1, prompt: 2, silence: 4 } as const;
const sizes: Record<MediaFormat, number> = { 1: 320, 2: 640, 3: 1920 };

export interface MediaFrame {
  format: MediaFormat;
  flags: number;
  seq: number;
  captureTs: number;
  pcm: Uint8Array;
}

function validate(frame: MediaFrame): void {
  if (!(frame.format === 1 || frame.format === 2 || frame.format === 3)) throw new RangeError('invalid media format');
  if (!Number.isInteger(frame.flags) || frame.flags < 0 || frame.flags > 7) throw new RangeError('invalid media flags');
  for (const value of [frame.seq, frame.captureTs]) {
    if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) throw new RangeError('invalid uint32');
  }
  if (!(frame.pcm instanceof Uint8Array) || frame.pcm.length !== ((frame.flags & MEDIA_FLAGS.silence) ? 0 : sizes[frame.format])) throw new RangeError('invalid PCM length');
}

export function encodeMediaFrame(frame: MediaFrame): Uint8Array {
  validate(frame);
  const result = new Uint8Array(MEDIA_HEADER_BYTES + frame.pcm.length);
  const view = new DataView(result.buffer);
  result.set([1, frame.format, frame.flags, 0]);
  view.setUint32(4, frame.seq, true);
  view.setUint32(8, frame.captureTs, true);
  result.set(frame.pcm, MEDIA_HEADER_BYTES);
  return result;
}

export function decodeMediaFrame(bytes: Uint8Array): MediaFrame {
  if (bytes.length < MEDIA_HEADER_BYTES || bytes[0] !== 1 || bytes[3] !== 0) throw new RangeError('invalid media header');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const frame: MediaFrame = { format: bytes[1] as MediaFormat, flags: bytes[2], seq: view.getUint32(4, true), captureTs: view.getUint32(8, true), pcm: bytes.slice(MEDIA_HEADER_BYTES) };
  validate(frame);
  return frame;
}

export function nextSequence(seq: number): number {
  if (!Number.isInteger(seq) || seq < 0 || seq > 0xffffffff) throw new RangeError('invalid sequence');
  return (seq + 1) >>> 0;
}
