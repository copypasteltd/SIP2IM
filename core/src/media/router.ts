import { MediaLeg } from './leg.js';
/** The owner calls tick every 20 ms and owns timer lifecycle. */
export class MediaRouter {
  constructor(readonly a: MediaLeg, readonly b: MediaLeg) {}
  tick(now: number, receiverNow = now): void {
    const a = this.a.read(receiverNow), b = this.b.read(receiverNow);
    this.b.write(a.pcm, a.flags, now); this.a.write(b.pcm, b.flags, now);
  }
}
