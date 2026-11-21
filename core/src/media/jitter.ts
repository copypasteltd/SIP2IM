import type { MediaFrame } from '@voipgw/protocol';

const distance = (seq: number, base: number): number => (seq - base) | 0;
/** Call push on arrival and pop once per 20ms playout tick. */
export class JitterBuffer {
  private readonly frames = new Map<number, MediaFrame>();
  private expected: number | undefined;
  private started = false;
  private lastArrival: number | undefined;
  private lastSeq: number | undefined;
  private jitter = 0;
  targetMs = 80;
  get size(): number { return this.frames.size; }
  push(frame: MediaFrame, arrivalMs: number): boolean {
    if (!Number.isFinite(arrivalMs)) throw new RangeError('invalid arrival time');
    if (this.expected === undefined) this.expected = frame.seq;
    const d = distance(frame.seq, this.expected);
    if (d < 0) {
      if (this.started || d < -15) return false;
      this.expected = frame.seq;
    }
    if (this.frames.has(frame.seq)) return false;
    if (this.lastArrival !== undefined && this.lastSeq !== undefined) {
      const seqDelta = distance(frame.seq, this.lastSeq);
      if (seqDelta > 0) {
        const variation = Math.abs((arrivalMs - this.lastArrival) - 20 * seqDelta);
        this.jitter += (variation - this.jitter) / 16;
        this.targetMs = Math.max(60, Math.min(120, Math.round((80 + 4 * this.jitter) / 20) * 20));
      }
    }
    if (this.lastSeq === undefined || distance(frame.seq, this.lastSeq) > 0) { this.lastSeq = frame.seq; this.lastArrival = arrivalMs; }
    this.frames.set(frame.seq, { ...frame, pcm: frame.pcm.slice() });
    // Bound both packet count and sequence-span latency, even after a long gap.
    if (distance(frame.seq, this.expected!) >= 15) {
      const cutoff = (frame.seq - 14) >>> 0;
      for (const seq of this.frames.keys()) if (distance(seq, cutoff) < 0) this.frames.delete(seq);
      this.expected = cutoff;
    }
    while (this.frames.size > 15) { this.frames.delete(this.expected!); this.expected = (this.expected! + 1) >>> 0; }
    return true;
  }
  pop(): MediaFrame | undefined {
    if (this.expected === undefined) return undefined;
    if (!this.started) {
      if (this.frames.size < this.targetMs / 20) return undefined;
      this.started = true;
    }
    const frame = this.frames.get(this.expected);
    this.frames.delete(this.expected);
    this.expected = (this.expected + 1) >>> 0;
    return frame;
  }
  clear(): void { this.frames.clear(); this.expected = undefined; this.started = false; this.lastArrival = undefined; this.lastSeq = undefined; this.jitter = 0; this.targetMs = 80; }
}
