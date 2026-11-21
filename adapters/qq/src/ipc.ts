export const MAX_FRAME = 1024 * 1024;

export function encodeFrame(kind: number, body: Uint8Array): Buffer {
  if ((kind !== 1 && kind !== 2) || body.length + 1 > MAX_FRAME) throw new Error('invalid frame');
  const frame = Buffer.alloc(5 + body.length);
  frame.writeUInt32BE(body.length + 1, 0);
  frame[4] = kind;
  frame.set(body, 5);
  return frame;
}

export class FrameDecoder {
  private buffer = Buffer.alloc(0);
  feed(data: Uint8Array): Array<{ kind: number; body: Buffer }> {
    this.buffer = Buffer.concat([this.buffer, data]);
    const frames: Array<{ kind: number; body: Buffer }> = [];
    while (this.buffer.length >= 4) {
      const size = this.buffer.readUInt32BE(0);
      if (size < 1 || size > MAX_FRAME) throw new Error('invalid frame length');
      if (this.buffer.length < size + 4) break;
      const kind = this.buffer[4];
      if (kind !== 1 && kind !== 2) throw new Error('invalid frame type');
      frames.push({ kind, body: Buffer.from(this.buffer.subarray(5, size + 4)) });
      this.buffer = this.buffer.subarray(size + 4);
    }
    return frames;
  }
}
