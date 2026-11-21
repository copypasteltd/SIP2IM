import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import net from 'node:net';
import { test } from 'node:test';
import { Client, envelope } from '../src/main.mjs';

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

function decodeControl(bytes) {
  assert.equal(bytes.readUInt32BE(), bytes.length - 4);
  assert.equal(bytes[4], 1);
  return JSON.parse(bytes.subarray(5).toString('utf8'));
}

function decodeAck(bytes) {
  const message = decodeControl(bytes);
  assert.equal(message.type, 'ack');
  return message.payload;
}

function frame(body) {
  const bytes = Buffer.alloc(5 + body.length);
  bytes.writeUInt32BE(body.length + 1);
  bytes[4] = 1;
  body.copy(bytes, 5);
  return bytes;
}

const wire = message => frame(Buffer.from(JSON.stringify(message)));
const ack = (refId, ok = true, error = null) => envelope('ack', {refId, ok, error});
const accountState = () => envelope('account.state', {state:'logged_out',selfId:null,alias:null,detail:null});

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
    await check(socket, writes, client);
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

test('real QQ stream rejects malformed ACKs without completing hello', async (t) => {
  const invalid = {
    'positive with error': ref => wire(ack(ref, true, 'INTERNAL')),
    'negative with null': ref => wire(ack(ref, false, null)),
    'unknown error code': ref => wire(ack(ref, false, 'NOT_A_SHARED_CODE')),
    'numeric reference': () => wire(ack(123)),
    'out-of-range timestamp': ref => wire({...ack(ref), ts: 8640000000000001}),
    'malformed UTF-8 in otherwise valid ACK': ref => {
      const prefix = JSON.stringify({...ack(ref), ignored: ''}).slice(0, -2);
      return frame(Buffer.concat([Buffer.from(prefix), fromHex(ipcFrames.malformedUtf8Hex).subarray(5), Buffer.from('"}')]));
    },
  };
  for (const [name, makeFrame] of Object.entries(invalid)) await t.test(name, async () => {
    await withIngress(undefined, async (socket, writes, client) => {
      const send = client.send.bind(client);
      let helloResult;
      client.send = (message, peer) => {
        const result = send(message, peer);
        if (message.type === 'adapter.hello') helloResult = result.catch(error => error.message);
        return result;
      };
      socket.emit('connect');
      assert.equal(writes.length, 1);
      const hello = decodeControl(writes[0]);
      assert.equal(hello.type, 'adapter.hello');
      assert.equal(client.pending.has(hello.id), true);
      socket.emit('data', makeFrame(hello.id));
      await flush();
      assert.equal(socket.destroyed, true);
      assert.equal(writes.length, 1);
      assert.equal(client.pending.size, 0);
      assert.equal(await helloResult, 'disconnected; outcome unknown');
    });
  });
});

test('real QQ stream selects only the exact pending reference and ignores expired ACKs', async () => {
  await withIngress(undefined, async (socket, writes, client) => {
    socket.emit('connect');
    const hello = decodeControl(writes[0]);
    for (const ref of ['', 'opaque-ref', hello.id.toLowerCase(), hello.id + ' ']) {
      socket.emit('data', wire(ack(ref)));
    }
    await flush();
    assert.equal(socket.destroyed, false);
    assert.equal(writes.length, 1);
    assert.equal(client.pending.has(hello.id), true);
    socket.emit('data', wire(ack(hello.id)));
    await flush();
    const caps = decodeControl(writes[1]);
    assert.equal(caps.type, 'capabilities');
    assert.ok(Object.values(caps.payload).every(value => !value));
    socket.emit('data', wire(ack(caps.id)));
    await flush();
    const state = decodeControl(writes[2]);
    assert.equal(state.type, 'account.state');
    assert.equal(state.payload.state, 'logged_out');
    socket.emit('data', frame(Buffer.concat([fromHex('efbbbf'), wire(ack(state.id)).subarray(5)])));
    await flush();
    assert.equal(client.pending.size, 0);

    client.timeout = 10;
    const expired = accountState();
    await assert.rejects(client.send(expired), /ack timeout; outcome unknown/);
    client.timeout = 1000;
    const selected = accountState();
    const result = client.send(selected);
    try {
      socket.emit('data', wire(ack(expired.id)));
      assert.equal(client.pending.has(selected.id), true);
      assert.equal(writes.length, 5);
      socket.emit('data', wire(ack(selected.id)));
      assert.deepEqual(await result, {refId:selected.id,ok:true,error:null});
    } finally {
      socket.destroy();
      await result.catch(() => {});
    }
  });
});

test('real QQ stream accepts all shared negative ACK codes without rewriting them', async () => {
  // Read the TS declaration without evaluating it or requiring a protocol build.
  const source = readFileSync(new URL('../../../packages/protocol/src/errors.ts', import.meta.url), 'utf8');
  const declared = source.match(/export const ERROR_CODES\s*=\s*\[([^\]]+)\]/)?.[1];
  assert.ok(declared);
  const codes = Array.from(declared.matchAll(/['"]([A-Z_]+)['"]/g), match => match[1]);
  assert.ok(codes.includes('TIMEOUT_UNKNOWN'));
  await withIngress(undefined, async (socket, writes, client) => {
    for (const error of codes) {
      const message = accountState();
      const result = client.send(message);
      socket.emit('data', wire(ack(message.id, false, error)));
      assert.deepEqual(await result, {refId:message.id,ok:false,error}, error);
    }
    assert.equal(socket.destroyed, false);
    assert.equal(writes.length, codes.length);
  });
});

test('real QQ stream enforces the shared timestamp range before dispatch', async () => {
  const calls = [];
  await withIngress(async (type, payload) => { calls.push([type, payload]); return [true, null]; }, async (socket, writes) => {
    const cases = [[0,true], [8640000000000000,true], [8640000000000001,false], [Number.MAX_SAFE_INTEGER,false], [-1,false], [1.5,false], [true,false], ['1',false]];
    const messages = cases.map(([ts]) => ({...envelope('message.send', ipcFrames.control.message.payload), ts}));
    socket.emit('data', Buffer.concat(messages.map(wire)));
    await flush();
    assert.equal(socket.destroyed, false);
    assert.deepEqual(calls, cases.filter(([,valid]) => valid).map(() => ['message.send', ipcFrames.control.message.payload]));
    assert.deepEqual(writes.map(decodeAck), messages.map(({id}, i) => ({refId:id,ok:cases[i][1],error:cases[i][1] ? null : 'BAD_MESSAGE'})));
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
