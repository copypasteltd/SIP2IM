import { decodeMediaFrame, encodeMediaFrame } from './media.js';
import type { MediaFrame } from './media.js';

export const IPC_MAX_LENGTH = 1024 * 1024;
export type IpcFrame = { type: 1; data: Uint8Array } | { type: 2; audioChannel: number; media: MediaFrame };

export function encodeIpcFrame(frame: IpcFrame): Uint8Array {
  let body: Uint8Array;
  if (frame.type === 1) body = frame.data;
  else if (frame.type === 2) {
    if (!Number.isInteger(frame.audioChannel) || frame.audioChannel < 0 || frame.audioChannel > 255 || frame.media.format !== 3) throw new RangeError('invalid IPC audio');
    const media = encodeMediaFrame(frame.media);
    body = new Uint8Array(media.length + 1);
    body[0] = frame.audioChannel;
    body.set(media, 1);
  } else throw new RangeError('invalid IPC type');
  const length = body.length + 1;
  if (length > IPC_MAX_LENGTH) throw new RangeError('IPC frame too large');
  const result = new Uint8Array(4 + length);
  new DataView(result.buffer).setUint32(0, length, false);
  result[4] = frame.type;
  result.set(body, 5);
  return result;
}

function decodeComplete(bytes: Uint8Array): IpcFrame {
  if (bytes[4] === 1) return { type: 1, data: bytes.slice(5) };
  if (bytes[4] === 2 && bytes.length >= 6) {
    const media = decodeMediaFrame(bytes.subarray(6));
    if (media.format !== 3) throw new RangeError('invalid IPC audio format');
    return { type: 2, audioChannel: bytes[5], media };
  }
  throw new RangeError('invalid IPC type');
}

/** Incremental decoder. A malformed frame poisons the decoder; discard it after an error. */
export class IpcDecoder {
  private header = new Uint8Array(4);
  private headerUsed = 0;
  private pending: Uint8Array | undefined;
  private used = 0;
  private failed = false;
  push(chunk: Uint8Array): IpcFrame[] {
    if (this.failed) throw new Error('decoder has failed');
    const frames: IpcFrame[] = [];
    try {
      let offset = 0;
      while (offset < chunk.length) {
        if (!this.pending) {
          const take = Math.min(4 - this.headerUsed, chunk.length - offset);
          this.header.set(chunk.subarray(offset, offset + take), this.headerUsed);
          this.headerUsed += take; offset += take;
          if (this.headerUsed < 4) continue;
          const length = new DataView(this.header.buffer).getUint32(0, false);
          if (length < 1 || length > IPC_MAX_LENGTH) throw new RangeError('invalid IPC length');
          this.pending = new Uint8Array(4 + length);
          this.pending.set(this.header);
          this.used = 4;
        }
        const take = Math.min(this.pending.length - this.used, chunk.length - offset);
        this.pending.set(chunk.subarray(offset, offset + take), this.used);
        this.used += take; offset += take;
        if (this.used === this.pending.length) {
          frames.push(decodeComplete(this.pending));
          this.pending = undefined; this.headerUsed = 0; this.used = 0;
        }
      }
      return frames;
    } catch (error) { this.failed = true; this.pending = undefined; throw error; }
  }
  finish(): void { if (this.failed || this.headerUsed !== 0) throw new Error('incomplete or invalid IPC stream'); }
}
