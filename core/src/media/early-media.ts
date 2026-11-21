import { MEDIA_FLAGS } from '@voipgw/protocol';
export class EarlyMediaDetector {
  private readonly values: (number | undefined)[] = [];
  constructor(readonly thresholdDbfs: number) { if (!Number.isFinite(thresholdDbfs)) throw new RangeError('invalid threshold'); }
  /** Supply one cellular downlink frame per playout tick, including missing frames. */
  push(pcm: Uint8Array, flags: number): boolean {
    if (pcm.length !== 640) throw new RangeError('expected 20ms of 16kHz PCM');
    let rms = 0;
    if ((flags & MEDIA_FLAGS.earlyMedia) && !(flags & MEDIA_FLAGS.silence)) {
      const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
      for (let i = 0; i < 320; i++) rms += (view.getInt16(i * 2, true) / 32768) ** 2;
      rms = Math.sqrt(rms / 320);
    }
    this.values.push((flags & MEDIA_FLAGS.earlyMedia) ? rms : undefined); if (this.values.length > 50) this.values.shift();
    const flagged = this.values.filter((v): v is number => v !== undefined);
    const average = flagged.length ? flagged.reduce((a, b) => a + b, 0) / flagged.length : 0;
    return average > 0 && 20 * Math.log10(average) >= this.thresholdDbfs;
  }
}
