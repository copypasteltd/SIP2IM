import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import net from 'node:net';
import { test } from 'node:test';
import { Client } from '../src/main.mjs';

const fixture = path => JSON.parse(readFileSync(new URL('../../../packages/protocol/fixtures/' + path, import.meta.url), 'utf8'));
const incomingTypes = new Set([
  'account.login', 'account.login.submit', 'account.logout',
  'message.send', 'call.dial', 'call.hangup', 'ack',
]);
const ipcFrames = fixture('ipc/frames.json');
const fromHex = hex => Buffer.from(hex, 'hex');
const flush = () => new Promise(resolve => setImmediate(resolve));

function memorySocket() {
  const socket = new EventEmitter();
  const writes = [];
  socket.destroyed = false;
  socket.write = bytes => writes.push(Buffer.from(bytes));
  socket.destroy = () => {
    if (!socket.destroyed) { socket.destroyed = true; socket.emit('close'); }
  };
  return { socket, writes };
}

function decodeAck(bytes) {
  assert.equal(bytes.readUInt32BE(), bytes.length - 4);
  assert.equal(bytes[4], 1);
  const message = JSON.parse(bytes.subarray(5).toString('utf8'));
  assert.equal(message.type, 'ack');
  return message.payload;
}

async function withIngress(handler, check) {
  const { socket, writes } = memorySocket();
  const client = new Client('unused', handler);
  const original = net.createConnection;
  let closed;
  try {
    net.createConnection = () => socket;
    closed = client.connect();
  } finally {
    net.createConnection = original;
  }
  try {
    await check(socket, writes);
  } finally {
    socket.destroy();
    await closed;
  }
}

test('real QQ client accepts six shared commands and rejects their invalid envelopes', async () => {
  const cases = fixture('ipc/messages.json').filter(row => incomingTypes.has(row.valid.type) && row.valid.type !== 'ack');
  assert.deepEqual(new Set(cases.map(row => row.valid.type)), new Set([...incomingTypes].filter(type => type !== 'ack')));
  for (const { valid, invalid } of cases) {
    const { socket, writes } = memorySocket();
    const calls = [];
    const client = new Client('unused', async (type, payload) => { calls.push([type, payload]); return [true, null]; });
    client.socket = socket;
    await client.receive(valid);
    await client.receive(invalid);
    assert.deepEqual(calls, [[valid.type, valid.payload]], valid.type);
    assert.deepEqual(writes.map(decodeAck), [
      { refId: valid.id, ok: true, error: null },
      { refId: invalid.id, ok: false, error: 'BAD_MESSAGE' },
    ], valid.type);
  }
});

test('real QQ client settles a shared ACK and rejects its invalid envelope', async () => {
  const { valid, invalid } = fixture('ipc/messages.json').find(row => row.valid.type === 'ack');
  const { socket } = memorySocket();
  const client = new Client('unused', undefined, 100);
  client.socket = socket;
  const running = client.send({ ...ipcFrames.control.message, id: valid.payload.refId });
  await client.receive(valid);
  assert.deepEqual(await running, valid.payload);
  assert.equal(client.pending.size, 0);
  await client.receive(invalid);
  assert.equal(socket.destroyed, true);
});

test('real QQ client enforces shared IPC payload boundaries', async () => {
  const cases = fixture('ipc/command-boundaries.json');
  assert.ok(cases.length > 0);
  const incoming = new Map(fixture('ipc/messages.json').filter(row => incomingTypes.has(row.valid.type))
    .map(({ valid }) => [valid.type, valid]));
  for (const { name, type, payload, valid } of cases) {
    assert.ok(incoming.has(type), name);
    assert.equal(typeof valid, 'boolean', name);
    const message = { ...incoming.get(type), payload };
    const { socket, writes } = memorySocket();
    const calls = [];
    const client = new Client('unused', async (...args) => { calls.push(args); return [true, null]; });
    client.socket = socket;
    await client.receive(message);
    if (type === 'ack') {
      assert.equal(socket.destroyed, !valid, name);
      assert.deepEqual(calls, [], name);
      assert.deepEqual(writes, [], name);
    } else {
      assert.equal(socket.destroyed, false, name);
      assert.deepEqual(calls, valid ? [[type, payload]] : [], name);
      assert.deepEqual(writes.map(decodeAck), [
        { refId: message.id, ok: valid, error: valid ? null : 'BAD_MESSAGE' },
      ], name);
    }
  }
});

test('real QQ client enforces shared canonical IPC envelope ID boundaries', async () => {
  const message = ipcFrames.control.message;
  for (const row of fixture('ulid-boundaries.json')) {
    const { socket, writes } = memorySocket();
    const client = new Client('unused', async () => [true, null]);
    client.socket = socket;
    const id = 'ipc_' + row.id.slice('dev_'.length);
    await client.receive({ ...message, id });
    assert.equal(socket.destroyed, !row.valid, id);
    assert.deepEqual(writes.map(decodeAck), row.valid ? [{ refId: id, ok: true, error: null }] : [], id);
  }
});

test('real QQ stream accepts fragmented shared UTF-8 control frames', async () => {
  const { message, wireHex } = ipcFrames.control;
  const calls = [];
  await withIngress(async (type, payload) => { calls.push([type, payload]); return [true, null]; }, async (socket, writes) => {
    const bytes = fromHex(wireHex);
    socket.emit('data', bytes.subarray(0, 3));
    await flush();
    assert.deepEqual(calls, []);
    socket.emit('data', bytes.subarray(3));
    await flush();
    assert.deepEqual(calls, [[message.type, message.payload]]);
    assert.equal(socket.destroyed, false);
    assert.deepEqual(writes.map(decodeAck), [{ refId: message.id, ok: true, error: null }]);
  });
});

test('real QQ stream rejects shared malformed frames, malformed UTF-8, and unsupported audio', async () => {
  const cases = {
    ...ipcFrames.invalidFraming,
    malformedUtf8: ipcFrames.malformedUtf8Hex,
    unsupportedAudio: ipcFrames.audio.wireHex,
  };
  for (const [name, hex] of Object.entries(cases)) {
    const calls = [];
    await withIngress(async (...args) => { calls.push(args); return [true, null]; }, async (socket, writes) => {
      socket.emit('data', fromHex(hex));
      await flush();
      assert.equal(socket.destroyed, true, name);
      assert.deepEqual(calls, [], name);
      assert.deepEqual(writes, [], name);
    });
  }
});
