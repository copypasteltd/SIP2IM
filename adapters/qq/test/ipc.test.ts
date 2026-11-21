import assert from 'node:assert/strict';
import { test } from 'node:test';
import { encodeFrame, FrameDecoder, MAX_FRAME } from '../src/ipc.ts';
import { unsupportedCapabilities } from '../src/backend.ts';
test('fragmented and combined frames', () => {
  const data = Buffer.concat([encodeFrame(1, Buffer.from('{}')), encodeFrame(2, Buffer.from([4, 5]))]);
  const decoder = new FrameDecoder();
  assert.deepEqual(decoder.feed(data.subarray(0, 2)), []);
  assert.deepEqual(decoder.feed(data.subarray(2)).map(({ kind, body }) => [kind, [...body]]), [[1, [123, 125]], [2, [4, 5]]]);
});
test('rejects invalid frames', () => {
  for (const length of [0, MAX_FRAME + 1]) {
    const prefix = Buffer.alloc(4); prefix.writeUInt32BE(length);
    assert.throws(() => new FrameDecoder().feed(prefix));
  }
  assert.throws(() => new FrameDecoder().feed(Buffer.from([0, 0, 0, 1, 3])));
  assert.throws(() => encodeFrame(1, Buffer.alloc(MAX_FRAME)));
});
test('unsupported capabilities are false', () => {
  assert.ok(Object.values(unsupportedCapabilities).every(value => !value));
});
