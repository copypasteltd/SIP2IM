import type { MediaFrame } from '@voipgw/protocol';

const distance = (seq: number, base: number): number => (seq - base) | 0;
const MAX_BUFFERED_FRAMES = 15;
const MAX_FRAME_AGE_MS = 300;

/** Same receiver clock for arrival and playback, never the peer's capture timestamp. */
export function withinPlayoutWindow(arrival: number, now: number): boolean {
  return now >= arrival && now - arrival <= MAX_FRAME_AGE_MS;
}
/** Call push on arrival and pop once per 20ms playout tick. */
export class JitterBuffer {
  private readonly frames = new Map<number, { frame?: MediaFrame; arrivalMs: number }>();
  private expected: number | undefined;
  private started = false;
  private fixedStart = false;
  private lastAccepted: number | undefined;
  private lastArrival: number | undefined;
  private lastSeq: number | undefined;
  private jitter = 0;
  targetMs = 80;
  get size(): number {
    let queued = 0;
    for (const item of this.frames.values()) if (item.frame) queued++;
    return queued;
  }
  push(frame: MediaFrame, arrivalMs: number): boolean {
    if (!Number.isFinite(arrivalMs)) throw new RangeError('invalid arrival time');
    const relativeToHead = this.lastSeq === undefined ? undefined : distance(frame.seq, this.lastSeq);
    if (relativeToHead !== undefined && relativeToHead <= -MAX_BUFFERED_FRAMES) return false;
    if (this.lastAccepted !== undefined) {
      if (arrivalMs < this.lastAccepted) return false;
      if (!withinPlayoutWindow(this.lastAccepted, arrivalMs)) {
        // Rebuffer after a real receiver gap, even if silent playout advanced
        // beyond the resumed sequence. An old or repeated frame cannot reopen it.
        if (relativeToHead === undefined || relativeToHead <= 0) return false;
        this.clear();
        this.fixedStart = true;
      }
    }
    if (this.expected === undefined) this.expected = frame.seq;
    const d = distance(frame.seq, this.expected);
    if (d < 0) {
      // Before priming, only move the window backward for a genuinely earlier
      // packet near its head, not for a half-range-ambiguous jump relative to expected.
      if (this.started || this.fixedStart || relativeToHead === undefined || relativeToHead >= 0) return false;
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
    // Bound both packet count and sequence-span latency, even after a long gap.
    if (d >= MAX_BUFFERED_FRAMES) {
      const cutoff = (frame.seq - MAX_BUFFERED_FRAMES + 1) >>> 0;
      for (const seq of this.frames.keys()) if (distance(seq, cutoff) < 0) this.frames.delete(seq);
      this.expected = cutoff;
      this.fixedStart = true;
    }
    this.lastAccepted = arrivalMs;
    this.frames.set(frame.seq, { frame: { ...frame, pcm: frame.pcm.slice() }, arrivalMs });
    return true;
  }
  pop(now: number): MediaFrame | undefined {
    if (this.expected === undefined) return undefined;
    // The sequence-span bound alone does not age out a queue when ticking pauses.
    for (const item of this.frames.values()) {
      // Keep the bounded sequence slot, not its PCM, until playout or eviction.
      // Otherwise a repeated sequence could count as new during initial buffering.
      if (!withinPlayoutWindow(item.arrivalMs, now)) delete item.frame;
    }
    if (!this.started) {
      if (this.size < this.targetMs / 20) return undefined;
      this.started = true;
    }
    const frame = this.frames.get(this.expected);
    this.frames.delete(this.expected);
    this.expected = (this.expected + 1) >>> 0;
    return frame?.frame;
  }
  clear(): void { this.frames.clear(); this.expected = undefined; this.started = false; this.fixedStart = false; this.lastAccepted = undefined; this.lastArrival = undefined; this.lastSeq = undefined; this.jitter = 0; this.targetMs = 80; }
}
