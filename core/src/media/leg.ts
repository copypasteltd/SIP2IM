import { decodeMediaFrame, MEDIA_FLAGS } from '@voipgw/protocol';
import type { MediaFormat, MediaFrame } from '@voipgw/protocol';
import { JitterBuffer, withinPlayoutWindow } from './jitter.js';
import { PcmResampler, SAMPLE_RATES } from './resample.js';

export type LegKind = 'device' | 'browser' | 'adapter';
const MEDIA_STALL_MS = 2_000;
export class MediaLeg {
  readonly jitter = new JitterBuffer();
  format: MediaFormat | undefined;
  private inbound: PcmResampler | undefined;
  private outbound: PcmResampler | undefined;
  private failures: number[] = [];
  private lastFrame: number;
  private acceptedFrame = false;
  private stalled = false;
  private sequence = 0;
  closed = false;
  constructor(readonly kind: LegKind, readonly send: (frame: MediaFrame) => void, readonly event: (name: string) => void = () => {}, now = 0) { this.lastFrame = now; }
  receive(bytes: Uint8Array, now: number): boolean {
    if (this.closed) return false;
    let frame: MediaFrame;
    try { frame = decodeMediaFrame(bytes); } catch {
      this.failures = this.failures.filter(t => now - t < 60000); this.failures.push(now);
      if (this.failures.length > 50) { this.close(); this.event('media_parse_failures'); }
      return false;
    }
    if ((this.kind === 'browser' && frame.format !== 2) || (this.kind === 'adapter' && frame.format !== 3) || (this.kind === 'device' && frame.format === 3) || (this.format !== undefined && frame.format !== this.format)) {
      this.close(); this.event('media_format_changed'); return false;
    }
    if (this.format === undefined) {
      this.format = frame.format;
      this.inbound = new PcmResampler(SAMPLE_RATES[frame.format], 16000);
      this.outbound = new PcmResampler(16000, SAMPLE_RATES[frame.format]);
    }
    if (!this.jitter.push(frame, now)) return false;
    if (this.acceptedFrame && !withinPlayoutWindow(this.lastFrame, now)) {
      this.inbound = new PcmResampler(SAMPLE_RATES[frame.format], 16000);
    }
    this.lastFrame = now; this.acceptedFrame = true; this.stalled = false;
    return true;
  }
  ready(now: number): boolean {
    return !this.closed && this.acceptedFrame && now >= this.lastFrame && now - this.lastFrame < MEDIA_STALL_MS;
  }
  checkStalled(now: number): void {
    if (!this.closed && !this.stalled && now - this.lastFrame >= MEDIA_STALL_MS) {
      this.stalled = true;
      this.event('media_stalled');
    }
  }
  read(now: number): { pcm: Uint8Array; flags: number } {
    if (this.closed) return { pcm: new Uint8Array(640), flags: MEDIA_FLAGS.silence };
    const frame = this.jitter.pop(now);
    if (!frame || (frame.flags & MEDIA_FLAGS.silence)) {
      if (this.inbound && this.format) this.inbound.process(new Uint8Array(SAMPLE_RATES[this.format] / 50 * 2));
      return { pcm: new Uint8Array(640), flags: frame?.flags ?? MEDIA_FLAGS.silence };
    }
    return { pcm: this.inbound!.process(frame.pcm), flags: frame.flags };
  }
  write(pcm: Uint8Array, flags: number, now: number): boolean {
    if (this.closed || this.format === undefined || !this.outbound) return false;
    if (pcm.length !== 640) throw new RangeError('expected 20ms of 16kHz PCM');
    const silent = (flags & MEDIA_FLAGS.silence) !== 0;
    // Advance filter state through silence as well, avoiding stale audio on resume.
    const converted = this.outbound.process(silent ? new Uint8Array(640) : pcm);
    this.send({ format: this.format, flags, seq: this.sequence, captureTs: Math.floor(now) >>> 0, pcm: silent ? new Uint8Array(0) : converted });
    this.sequence = (this.sequence + 1) >>> 0; return true;
  }
  /** Reset stream state on reconnect while preserving leg identity and negotiated format. */
  resetConnection(now: number): void {
    if (this.closed) return;
    this.jitter.clear(); this.sequence = 0; this.lastFrame = now; this.acceptedFrame = false; this.stalled = false;
    if (this.format !== undefined) {
      this.inbound = new PcmResampler(SAMPLE_RATES[this.format], 16000);
      this.outbound = new PcmResampler(16000, SAMPLE_RATES[this.format]);
    }
  }
  close(): void { this.closed = true; this.jitter.clear(); }
}
