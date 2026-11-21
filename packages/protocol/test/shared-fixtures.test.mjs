import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  decodeAdapterJson, decodeMediaFrame, encodeAdapterJson, encodeIpcFrame, encodeMediaFrame,
  IpcDecoder, parseAdapterMessage, parseDeviceMessage,
} from '../dist/index.js';

const fixture = path => readFileSync(new URL('../fixtures/' + path, import.meta.url), 'utf8');
const rows = path => {
  const [, ...cases] = fixture(path).trimEnd().split(/\r?\n/);
  assert.ok(cases.length > 0, path);
  return cases.map(line => line.split('\t'));
};
const fromHex = hex => Uint8Array.from(Buffer.from(hex, 'hex'));

test('shared call.reject vectors preserve optional generation and reject bad IDs', () => {
  for (const [name, commandId, callId, generation, valid] of rows('device/call-reject-generation.tsv')) {
    assert.ok(['true', 'false'].includes(valid), name);
    const payload = generation === '-' ? { callId } : { callId, generation };
    const message = { v: 1, type: 'call.reject', id: commandId, ts: 1, payload };
    if (valid === 'true') assert.deepEqual(parseDeviceMessage(message, 'command'), message, name);
    else assert.throws(() => parseDeviceMessage(message, 'command'), undefined, name);
  }
});

test('shared media vectors encode and decode exact v1 bytes', () => {
  for (const [name, valid, headerHex, sampleHex, samples, format, flags, seq, captureTs] of rows('media-v1.tsv')) {
    assert.ok(['true', 'false'].includes(valid), name);
    const pcmHex = sampleHex.repeat(Number(samples));
    const bytes = fromHex(headerHex + pcmHex);
    if (valid === 'false') {
      assert.throws(() => decodeMediaFrame(bytes), RangeError, name);
      continue;
    }
    const frame = { format: Number(format), flags: Number(flags), seq: Number(seq), captureTs: Number(captureTs), pcm: fromHex(pcmHex) };
    assert.deepEqual(decodeMediaFrame(bytes), frame, name);
    assert.deepEqual(encodeMediaFrame(frame), bytes, name);
  }
});

test('shared IPC command vectors test payload boundaries in otherwise valid envelopes', () => {
  const cases = JSON.parse(fixture('ipc/command-boundaries.json'));
  assert.ok(cases.length > 0);
  const incoming = new Map(JSON.parse(fixture('ipc/messages.json')).map(({ valid }) => [valid.type, valid]));
  for (const { name, type, payload, valid } of cases) {
    assert.ok(incoming.has(type), name);
    assert.equal(typeof valid, 'boolean', name);
    const message = { ...incoming.get(type), payload };
    if (valid) assert.deepEqual(parseAdapterMessage(message), message, name);
    else assert.throws(() => parseAdapterMessage(message), undefined, name);
  }
});

const ipc = JSON.parse(fixture('ipc/frames.json'));

test('shared IPC vectors preserve fragmented control and audio frame bytes', () => {
  const control = { type: 1, data: encodeAdapterJson(ipc.control.message) };
  const audio = { type: 2, audioChannel: ipc.audio.channel, media: decodeMediaFrame(fromHex(ipc.audio.mediaHex)) };
  const controlBytes = fromHex(ipc.control.wireHex);
  const audioBytes = fromHex(ipc.audio.wireHex);
  assert.deepEqual(encodeIpcFrame(control), controlBytes);
  assert.deepEqual(encodeIpcFrame(audio), audioBytes);

  const decoder = new IpcDecoder();
  assert.deepEqual(decoder.push(controlBytes.subarray(0, 3)), []);
  const frames = decoder.push(Uint8Array.from([...controlBytes.subarray(3), ...audioBytes]));
  decoder.finish();
  assert.deepEqual(frames, [control, audio]);
  assert.deepEqual(decodeAdapterJson(frames[0].data), ipc.control.message);
});

test('shared IPC vectors distinguish malformed framing from invalid control UTF-8', () => {
  for (const [name, hex] of Object.entries(ipc.invalidFraming)) {
    assert.throws(() => new IpcDecoder().push(fromHex(hex)), RangeError, name);
  }
  const decoder = new IpcDecoder();
  const [frame] = decoder.push(fromHex(ipc.malformedUtf8Hex));
  decoder.finish();
  assert.equal(frame.type, 1);
  assert.throws(() => decodeAdapterJson(frame.data), TypeError);
});
