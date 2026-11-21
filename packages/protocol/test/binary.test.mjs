import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeMediaFrame, decodeMediaFrame, nextSequence } from '../dist/media.js';
import { encodeIpcFrame, IpcDecoder } from '../dist/adapter.js';

for (const [format, size] of [[1,320],[2,640],[3,1920]]) {
  test('media round trip format ' + format, () => {
    for (const flags of [0,1,2,4,7]) {
      const frame = { format, flags, seq: 0xffffffff, captureTs: 123456, pcm: new Uint8Array(flags & 4 ? 0 : size).fill(42) };
      const bytes = encodeMediaFrame(frame);
      assert.deepEqual(decodeMediaFrame(bytes), frame);
      assert.equal(bytes[4], 255);
    }
  });
}
test('reject invalid media headers, sizes and values', () => {
  const bytes = encodeMediaFrame({ format: 1, flags: 0, seq: 1, captureTs: 2, pcm: new Uint8Array(320) });
  for (const [offset, value] of [[0,2],[1,4],[2,8],[3,1]]) { const bad = bytes.slice(); bad[offset] = value; assert.throws(() => decodeMediaFrame(bad)); }
  assert.throws(() => decodeMediaFrame(bytes.subarray(0, 12)));
  assert.throws(() => encodeMediaFrame({format:1, flags:4, seq:-1, captureTs:0, pcm:new Uint8Array()}));
  assert.equal(nextSequence(0xffffffff), 0);
});
test('IPC handles all split points and multiple frames', () => {
  const a = encodeIpcFrame({type:1, data:new TextEncoder().encode('{}')});
  const b = encodeIpcFrame({type:2, audioChannel:255, media:{format:3, flags:4, seq:0, captureTs:0, pcm:new Uint8Array()}});
  const combined = new Uint8Array(a.length+b.length); combined.set(a); combined.set(b,a.length);
  for (let split=0;split<=combined.length;split++) {
    const decoder = new IpcDecoder();
    const result = [...decoder.push(combined.subarray(0,split)), ...decoder.push(combined.subarray(split))];
    decoder.finish(); assert.equal(result.length,2); assert.equal(result[1].audioChannel,255);
  }
});
test('IPC decodes a maximum frame fragmented into single bytes', () => {
  const bytes=encodeIpcFrame({type:1,data:new Uint8Array(1024*1024-1).fill(42)});
  const decoder=new IpcDecoder(); let frames=[];
  for(let i=0;i<bytes.length;i++) frames.push(...decoder.push(bytes.subarray(i,i+1)));
  decoder.finish(); assert.equal(frames.length,1); assert.equal(frames[0].data.length,1024*1024-1); assert.equal(frames[0].data.at(-1),42);
});
test('IPC rejects malformed lengths, types and truncated streams', () => {
  for (const bytes of [new Uint8Array([0,0,0,0]),new Uint8Array([0,16,0,1]),new Uint8Array([0,0,0,1,3])]) {
    const d = new IpcDecoder(); assert.throws(() => d.push(bytes)); assert.throws(() => d.push(new Uint8Array()));
  }
  const d = new IpcDecoder(); d.push(new Uint8Array([0,0,0])); assert.throws(() => d.finish());
  assert.throws(() => encodeIpcFrame({type:2,audioChannel:0,media:{format:1,flags:4,seq:0,captureTs:0,pcm:new Uint8Array()}}));
});
