import type { MediaFormat } from '@voipgw/protocol';

export const SAMPLE_RATES: Record<MediaFormat, number> = { 1: 8000, 2: 16000, 3: 48000 };

/** Stateful causal linear interpolation with a one-pole anti-alias/reconstruction filter. */
export class PcmResampler {
  private previous = 0;
  private filtered = 0;
  constructor(readonly inputRate: number, readonly outputRate: number) {
    if (![inputRate, outputRate].every(n => Number.isInteger(n) && n > 0)) throw new RangeError('invalid sample rate');
  }
  process(pcm: Uint8Array): Uint8Array {
    if (pcm.length % 2) throw new RangeError('unaligned PCM16');
    const count = pcm.length / 2;
    const outputCount = count * this.outputRate / this.inputRate;
    if (!Number.isInteger(outputCount)) throw new RangeError('input must produce a whole number of samples');
    if (this.inputRate === this.outputRate) return pcm.slice();
    const src = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
    const samples = new Float64Array(count);
    const cutoff = 0.45 * Math.min(this.inputRate, this.outputRate);
    const alpha = 1 - Math.exp(-2 * Math.PI * cutoff / this.inputRate);
    for (let i = 0; i < count; i++) {
      this.filtered += alpha * (src.getInt16(i * 2, true) - this.filtered);
      samples[i] = this.filtered;
    }
    const out = new Uint8Array(outputCount * 2);
    const dst = new DataView(out.buffer);
    for (let i = 0; i < outputCount; i++) {
      const position = i * this.inputRate / this.outputRate - 1;
      const left = Math.floor(position), fraction = position - left;
      const a = left < 0 ? this.previous : samples[left]!;
      const b = left + 1 < 0 ? this.previous : samples[left + 1]!;
      dst.setInt16(i * 2, Math.max(-32768, Math.min(32767, Math.round(a + (b - a) * fraction))), true);
    }
    if (count) this.previous = samples[count - 1]!;
    return out;
  }
  reset(): void { this.previous = 0; this.filtered = 0; }
}
