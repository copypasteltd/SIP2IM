import { writeFile } from 'node:fs/promises';
const FRAME_BYTES=640;
export function toneFrame(seq, captureTs, amplitude=10000) {
 if (!Number.isInteger(seq) || seq<0 || seq>0xffffffff || !Number.isInteger(captureTs) || captureTs<0 || captureTs>0xffffffff || !Number.isInteger(amplitude) || amplitude<0 || amplitude>32767) throw new RangeError('invalid frame parameters');
 const frame=Buffer.alloc(12+FRAME_BYTES); frame[0]=1; frame[1]=2; frame.writeUInt32LE(seq,4); frame.writeUInt32LE(captureTs,8);
 for(let i=0;i<320;i++) frame.writeInt16LE(Math.round(amplitude*Math.sin(2*Math.PI*1000*i/16000)),12+i*2);
 return frame;
}
export function decodeFrame(data) {
 const b=Buffer.from(data); if(b.length<12 || b[0]!==1 || b[1]!==2 || b[2]>7 || b[3]!==0 || b.length!==12+((b[2]&4)?0:FRAME_BYTES)) throw new RangeError('invalid format-2 frame');
 return {seq:b.readUInt32LE(4),captureTs:b.readUInt32LE(8),flags:b[2],pcm:(b[2]&4)?Buffer.alloc(FRAME_BYTES):b.subarray(12)};
}
export function createRecorder() {
 let last=null,missing=0,duplicateOrReordered=0,frames=0,sumSquares=0,peak=0; const chunks=[];
 function accept(data) {
  const f=decodeFrame(data); if(last!==null) { const delta=(f.seq-last)>>>0; if(delta===0 || delta>=0x80000000) duplicateOrReordered++; else {missing+=delta-1; last=f.seq;} } else last=f.seq;
  frames++; const pcm=Buffer.from(f.pcm); chunks.push(pcm);
  for(let i=0;i<pcm.length;i+=2){const n=pcm.readInt16LE(i);sumSquares+=n*n;peak=Math.max(peak,Math.abs(n));}
 }
 function report(){return {frames,missing,duplicateOrReordered,rms:frames?Math.sqrt(sumSquares/(frames*320)):0,peak,latencyMs:null,latencyReason:'No synchronized clocks or loopback correlation measurement'};}
 function wav(){ const pcm=Buffer.concat(chunks); const h=Buffer.alloc(44);h.write('RIFF');h.writeUInt32LE(36+pcm.length,4);h.write('WAVEfmt ',8);h.writeUInt32LE(16,16);h.writeUInt16LE(1,20);h.writeUInt16LE(1,22);h.writeUInt32LE(16000,24);h.writeUInt32LE(32000,28);h.writeUInt16LE(2,32);h.writeUInt16LE(16,34);h.write('data',36);h.writeUInt32LE(pcm.length,40);return Buffer.concat([h,pcm]); }
 return {accept,report,wav,saveWav:async path=>writeFile(path,wav())};
}
