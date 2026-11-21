import test from 'node:test';
import assert from 'node:assert/strict';
import {toneFrame,decodeFrame,createRecorder} from './probe.mjs';
test('format-2 tone uses correct header and PCM dimensions',()=>{const b=toneFrame(0xffffffff,42);assert.equal(b.length,652);assert.deepEqual([...b.subarray(0,4)],[1,2,0,0]);assert.equal(decodeFrame(b).seq,0xffffffff);assert.throws(()=>decodeFrame(b.subarray(0,30)));});
test('recorder handles wrap, loss, silence, reordered frames and WAV',()=>{const r=createRecorder();r.accept(toneFrame(0xffffffff,0));r.accept(toneFrame(1,20));r.accept(toneFrame(1,20));const silence=Buffer.alloc(12);silence[0]=1;silence[1]=2;silence[2]=4;silence.writeUInt32LE(2,4);r.accept(silence);const x=r.report();assert.equal(x.missing,1);assert.equal(x.duplicateOrReordered,1);assert.equal(x.frames,4);assert.ok(x.rms>0);assert.equal(x.latencyMs,null);const w=r.wav();assert.equal(w.toString('ascii',0,4),'RIFF');assert.equal(w.readUInt32LE(40),4*640);});
