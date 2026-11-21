import { decodeMediaFrame, encodeMediaFrame } from '@voipgw/protocol';
import type { MediaFrame } from '@voipgw/protocol';
/** One instance per adapter; released channels can be reused. */
export class AdapterAudioChannels {
  private next = 0;
  private readonly channels = new Map<number, (frame: MediaFrame) => void>();
  allocate(receive: (frame: MediaFrame) => void): number {
    for (let i = 0; i < 256; i++) { const channel = this.next; this.next = (this.next + 1) % 256; if (!this.channels.has(channel)) { this.channels.set(channel, receive); return channel; } }
    throw new RangeError('no free audio channels');
  }
  release(channel: number): boolean { return this.channels.delete(channel); }
  receive(payload: Uint8Array): boolean {
    if (!payload.length) throw new RangeError('missing audio channel');
    const frame = decodeMediaFrame(payload.subarray(1));
    if (frame.format !== 3) throw new RangeError('invalid adapter audio format');
    const receiver = this.channels.get(payload[0]!); if (!receiver) return false;
    receiver(frame); return true;
  }
  static encode(channel: number, frame: MediaFrame): Uint8Array {
    if (!Number.isInteger(channel) || channel < 0 || channel > 255 || frame.format !== 3) throw new RangeError('invalid adapter audio');
    const encoded = encodeMediaFrame(frame), payload = new Uint8Array(encoded.length + 1); payload[0] = channel; payload.set(encoded, 1); return payload;
  }
}
