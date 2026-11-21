import { MEDIA_FLAGS } from '@voipgw/protocol';
/** Raw little-endian 16kHz mono PCM, supplied by the integration layer. */
export class PromptPlayer {
  private offset = 0;
  private readonly pcm: Uint8Array;
  constructor(pcm: Uint8Array) { if (!pcm.length || pcm.length % 2) throw new RangeError('invalid prompt PCM'); this.pcm = pcm.slice(); }
  next(): { pcm: Uint8Array; flags: number } {
    const pcm = new Uint8Array(640);
    for (let i = 0; i < pcm.length; i++) { pcm[i] = this.pcm[this.offset]!; this.offset = (this.offset + 1) % this.pcm.length; }
    return { pcm, flags: MEDIA_FLAGS.prompt };
  }
  reset(): void { this.offset = 0; }
}
