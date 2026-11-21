import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client, envelope } from '../src/main.mjs';
import { FakeBackend } from '../src/fake-backend.mjs';
import net from 'node:net';
import { EventEmitter } from 'node:events';

test('retry delay resets after stable connection', async () => {
  const client = new Client('unused'); const delays = []; let attempts = 0;
  client.connect = async () => ++attempts === 3;
  const original = globalThis.setTimeout;
  globalThis.setTimeout = (callback, delay) => {
    delays.push(delay); if (delays.length === 5) client.stopped = true;
    queueMicrotask(callback); return 1;
  };
  try { await client.run(); } finally { globalThis.setTimeout = original; }
  assert.deepEqual(delays, [1000, 2000, 1000, 2000, 4000]);
});

test('null JSON frame closes its connection without throwing', async () => {
  const original = net.createConnection;
  const socket = new EventEmitter(); socket.destroyed = false;
  socket.destroy = () => { socket.destroyed = true; socket.emit('close'); };
  net.createConnection = () => socket;
  try {
    const client = new Client('unused'); const closed = client.connect();
    assert.doesNotThrow(() => socket.emit('data', Buffer.from([0,0,0,5,1,110,117,108,108])));
    await closed; assert.equal(socket.destroyed, true);
  } finally { net.createConnection = original; }
});
test('in-flight command survives reconnect without duplicate execution or stale ACK', async () => {
  let resolve; let calls = 0;
  const client = new Client('unused', async () => { calls++; await new Promise(r => { resolve = r; }); return [true, null]; });
  const oldFrames = [], newFrames = [];
  const oldSocket = {destroyed:false, write: data => oldFrames.push(data)};
  const newSocket = {destroyed:false, write: data => newFrames.push(data)};
  client.socket = oldSocket;
  const message = envelope('message.send', {userId:'fake',text:'hello'});
  const first = client.receive(message, oldSocket);
  oldSocket.destroyed = true; client.socket = newSocket;
  const second = client.receive(message, newSocket);
  assert.equal(calls, 1); resolve(); await Promise.all([first, second]);
  assert.equal(oldFrames.length, 0); assert.equal(newFrames.length, 1);
  assert.equal(JSON.parse(newFrames[0].subarray(5)).payload.refId, message.id);
});

test('fake receives duplicate command only once', async () => {
  const backend = new FakeBackend(); const client = new Client('unused', backend.handle.bind(backend));
  const frames = []; client.socket = { destroyed:false, write: data => frames.push(data), destroy() { this.destroyed = true; } };
  const message = envelope('message.send', {userId:'fake',text:'hello'});
  await client.receive(message); await client.receive(message);
  assert.deepEqual(backend.messages, [['fake','hello']]);
  assert.equal(frames.length, 2);
  assert.deepEqual(frames[0], frames[1]);
  await client.receive(envelope('call.dial', {}));
  assert.equal(JSON.parse(frames[2].subarray(5)).payload.error, 'BAD_MESSAGE');
});
test('ack timeout is unknown and does not replay', async () => {
  const client = new Client('unused', undefined, 10); const frames = [];
  client.socket = {destroyed:false, write: data => frames.push(data)};
  await assert.rejects(client.send(envelope('account.state', {})), /unknown/);
  assert.equal(frames.length, 1); assert.equal(client.pending.size, 0);
});
test('matching ack resolves pending operation', async () => {
  const client = new Client('unused', undefined, 1000);
  client.socket = {destroyed:false, write() {}};
  const message = envelope('account.state', {}); const result = client.send(message);
  await client.receive(envelope('ack', {refId:message.id,ok:true,error:null}));
  assert.equal((await result).ok, true);
});
