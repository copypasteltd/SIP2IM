import { describe, expect, it } from 'vitest';
import { encodeMediaFrame, MEDIA_FLAGS } from '@voipgw/protocol';
import type { MediaFrame, MediaFormat } from '@voipgw/protocol';
import { JitterBuffer } from '../src/media/jitter.js';
import { MediaLeg } from '../src/media/leg.js';
import { MediaRouter } from '../src/media/router.js';
import { PcmResampler } from '../src/media/resample.js';
import { EarlyMediaDetector } from '../src/media/early-media.js';
import { PromptPlayer } from '../src/media/prompt-player.js';
import { AdapterAudioChannels } from '../src/media/adapter-audio.js';
const frame = (seq: number, format: MediaFormat = 2, value = 10000): MediaFrame => { const pcm = new Uint8Array(({1:320,2:640,3:1920})[format]); const v = new DataView(pcm.buffer); for(let i=0;i<pcm.length;i+=2) v.setInt16(i,value,true); return {format,flags:0,seq,captureTs:0,pcm}; };
describe('offline media', () => {
 it('orders wraparound packets, fills gaps and bounds latency', () => { const j=new JitterBuffer(); for(const [i,s] of [0xffffffff,1,0,2].entries()) j.push(frame(s),i*20); expect([j.pop(80)?.seq,j.pop(80)?.seq,j.pop(80)?.seq,j.pop(80)?.seq]).toEqual([0xffffffff,0,1,2]); expect(j.pop(80)).toBeUndefined(); expect(j.push(frame(1),100)).toBe(false); for(let i=4;i<30;i++) j.push(frame(i),i*20); expect(j.size).toBeLessThanOrEqual(15); });
 it('does not play expired PCM or renew a repeated sequence while priming', () => {
   const j = new JitterBuffer();
   j.push(frame(10), 0);
   j.push(frame(11), 20);
   expect(j.pop(301)).toBeUndefined(); // seq 10 aged out; seq 11 is still queued.
   expect(j.size).toBe(1);
   expect(j.push(frame(10), 301)).toBe(false);
   // A large arrival variation can raise the initial target to six frames.
   for (const [i, seq] of [12, 13, 14, 15, 16, 17].entries()) j.push(frame(seq), 302 + i * 20);
   // The playout clock also ages out seq 11. Missing slots produce silence.
   expect(j.pop(402)).toBeUndefined();
   expect(j.pop(422)).toBeUndefined();
   expect(j.pop(442)?.seq).toBe(12);
 });
 it('reprimes after a receiver gap without reopening old sequence numbers', () => {
   const j = new JitterBuffer();
   let seq = 0xffff_fffa;
   for (let i = 0; i < 4; i++) { j.push(frame(seq), i * 20); seq = (seq + 1) >>> 0; }
   expect(j.pop(80)?.seq).toBe(0xffff_fffa);
   for (let now = 100; now < 3_000; now += 20) j.pop(now);
   expect(j.push(frame(0xffff_fffd), 3_000)).toBe(false);
   expect(j.push(frame(0xffff_fffe), 3_000)).toBe(true);
   expect(j.push(frame(0xffff_fffc), 3_010)).toBe(false);
   expect(j.pop(3_010)).toBeUndefined();
   for (const [i, next] of [0xffff_ffff, 0, 1].entries()) j.push(frame(next), 3_020 + i * 20);
   expect([0, 1, 2, 3].map(i => j.pop(3_080 + i * 20)?.seq)).toEqual([0xffff_fffe, 0xffff_ffff, 0, 1]);
 });
 it('keeps the initial reordering window bounded on both sides of uint32 wrap', () => {
   for (const start of [0, 1, 100, 0xffff_fffc, 0xffff_ffff]) {
     const j = new JitterBuffer();
     const seq = (delta: number) => (start + delta) >>> 0;
     expect(j.push(frame(seq(0)), 0)).toBe(true);
     expect(j.push(frame(seq(14)), 20)).toBe(true);
     expect(j.push(frame(seq(-1)), 21)).toBe(false);
     expect(j.push(frame(seq(1)), 19)).toBe(false);
     for (let offset = 1; offset <= 14; offset++) j.push(frame(seq(offset)), 40 + offset * 10);
     expect(j.size).toBe(15);
     expect(j.push(frame(seq(15)), 191)).toBe(true);
     expect(j.size).toBe(15);
     expect(j.pop(200)?.seq).toBe(seq(1));
   }
 });
 it('holds the priming window when modulo comparisons disagree at the half-range boundary', () => {
   for (const first of [0, 100, 0xffff_fffa]) {
     const j = new JitterBuffer();
     const seq = (delta: number) => (first + delta) >>> 0;
     for (let i = 0; i < 4; i++) expect(j.push(frame(seq(i)), i * 20)).toBe(true);
     expect(j.push(frame(seq(0x8000_0000)), 65)).toBe(false);
     expect(j.size).toBe(4);
     expect(j.pop(80)?.seq).toBe(first);
   }
 });
 it('bounds frame age by receipt time rather than the sender timestamp', () => {
   for (const arrival of [0, 80, 1000, 0xffffffff]) {
     for (const [age, available] of [[299, true], [300, true], [301, false]] as const) {
       const j = new JitterBuffer();
       for (let seq = 0; seq < 6; seq++) j.push({...frame(seq),captureTs:(arrival + 502_001) >>> 0}, arrival);
       expect(j.pop(arrival + age)?.seq).toBe(available ? 0 : undefined);
       if (!available) expect(j.size).toBe(0);
     }
   }
 });
 it('only accepted frames renew the media stall clock, and an accepted forward sequence rearms it', () => {
   const events: string[] = [];
   const leg = new MediaLeg('device', () => {}, e => events.push(e), 0);
   expect(leg.receive(encodeMediaFrame(frame(5)), 1)).toBe(true);
   expect(leg.receive(encodeMediaFrame(frame(5)), 1500)).toBe(false);
   expect(leg.receive(encodeMediaFrame(frame(4)), 1999)).toBe(false);
   leg.checkStalled(2000);
   expect(events).toEqual([]);
   expect(leg.ready(2000)).toBe(true);
   leg.checkStalled(2001);
   expect(leg.ready(2001)).toBe(false);
   expect(leg.receive(encodeMediaFrame(frame(5)), 2500)).toBe(false);
   leg.checkStalled(2500);
   expect(events).toEqual(['media_stalled']);
   expect(leg.receive(encodeMediaFrame(frame(6)), 2600)).toBe(true);
   leg.checkStalled(4599);
   leg.checkStalled(4600);
   leg.checkStalled(4601);
   expect(events).toEqual(['media_stalled', 'media_stalled']);
 });
 it('routes in both directions and fills missing frames with silence', () => { const a:MediaFrame[]=[],b:MediaFrame[]=[]; const device=new MediaLeg('device', f=>a.push(f)), browser=new MediaLeg('browser',f=>b.push(f)); for(let i=0;i<4;i++){device.receive(encodeMediaFrame(frame(i,1)),i*20);browser.receive(encodeMediaFrame(frame(i,2)),i*20);} const router=new MediaRouter(device,browser); for(let i=0;i<5;i++)router.tick(100+i*20); expect(a[0]?.pcm.length).toBe(320); expect(b[0]?.pcm.length).toBe(640); expect((b[4]?.flags ?? 0) & MEDIA_FLAGS.silence).toBeTruthy(); });
 it('enforces format changes, stall and malformed frame threshold', () => { const events:string[]=[]; const l=new MediaLeg('device',()=>{},e=>events.push(e)); l.receive(encodeMediaFrame(frame(0)),0); l.checkStalled(2000); l.checkStalled(3000); expect(events).toEqual(['media_stalled']); l.receive(encodeMediaFrame(frame(1,1)),3000); expect(l.closed).toBe(true); expect(events[1]).toBe('media_format_changed'); const bad=new MediaLeg('browser',()=>{},e=>events.push(e)); for(let i=0;i<51;i++) bad.receive(new Uint8Array(),i); expect(bad.closed).toBe(true); });
 it.each(['format', 'parse'] as const)('discards queued audio after %s closure', (failure) => {
   const sent: MediaFrame[] = [];
   const device = new MediaLeg('device', () => {});
   const browser = new MediaLeg('browser', f => sent.push(f));
   for (let i = 0; i < 4; i++) {
     device.receive(encodeMediaFrame(frame(i, 2, 12000)), i * 20);
     browser.receive(encodeMediaFrame(frame(i, 2)), i * 20);
   }
   if (failure === 'format') device.receive(encodeMediaFrame(frame(4, 1)), 100);
   else for (let i = 0; i < 51; i++) device.receive(new Uint8Array(), 100 + i);
   expect(device.closed).toBe(true);
   expect(device.jitter.size).toBe(0);
   new MediaRouter(device, browser).tick(200);
   expect(sent[0]?.flags).toBe(MEDIA_FLAGS.silence);
   expect(sent[0]?.pcm.length).toBe(0);
 });
 it('filters high frequencies while preserving low frequencies', () => { const gain=(hz:number)=>{ const r=new PcmResampler(48000,16000); let energy=0; for(let k=0;k<10;k++){ const pcm=new Uint8Array(1920),v=new DataView(pcm.buffer); for(let i=0;i<960;i++)v.setInt16(i*2,Math.round(10000*Math.sin(2*Math.PI*hz*(k*960+i)/48000)),true); const out=r.process(pcm),o=new DataView(out.buffer); if(k>0)for(let i=0;i<320;i++)energy+=o.getInt16(i*2,true)**2; } return Math.sqrt(energy/(9*320)); }; expect(gain(1000)).toBeGreaterThan(6000); expect(gain(12000)).toBeLessThan(gain(1000)*0.6); });
 it('detects flagged early audio, loops prompts and allocates channels', () => { const d=new EarlyMediaDetector(-20); expect(d.push(frame(0).pcm,MEDIA_FLAGS.earlyMedia)).toBe(true); for(let i=0;i<50;i++) d.push(new Uint8Array(640),MEDIA_FLAGS.silence); expect(d.push(new Uint8Array(640),0)).toBe(false); const p=new PromptPlayer(new Uint8Array([1,2,3,4])); expect(Array.from(p.next().pcm.slice(0,8))).toEqual([1,2,3,4,1,2,3,4]); const c=new AdapterAudioChannels(); let seen=0; const id=c.allocate(()=>seen++); expect(c.receive(AdapterAudioChannels.encode(id,frame(0,3)))).toBe(true); expect(seen).toBe(1); expect(c.release(id)).toBe(true); });
});
