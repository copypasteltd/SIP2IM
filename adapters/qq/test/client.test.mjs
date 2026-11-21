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

const receipt = (refId,ok=true) => envelope('ack',{refId,ok,error:ok?null:'INTERNAL'});

for(const [at,ok] of [[9999,true],[9999,false],[10000,true],[10000,false]]) {
  test('admits only a timely exact ACK ('+at+'ms; ok='+ok+')', async () => {
    let now=0;
    const client=new Client('unused',undefined,10_000,()=>now), frames=[];
    const wire={destroyed:false,write:bytes=>frames.push(bytes)};
    client.socket=wire;
    const report=envelope('account.state',{}), pending=client.send(report);
    const observed=at===10_000?assert.rejects(pending,/ack timeout; outcome unknown/):pending;
    await assert.rejects(client.send(report),/already pending/);
    now=at;
    await client.receive(receipt(report.id),{...wire});
    await client.receive(receipt(envelope('account.state',{}).id));
    assert.equal(client.pending.size,1);
    const ack=receipt(report.id,ok);
    await client.receive(ack);
    if(at<10_000)assert.deepEqual(await observed,ack.payload);
    else await observed;
    await client.receive(receipt(report.id,!ok));
    assert.equal(client.pending.size,0);
    assert.equal(frames.length,1);
  });
}

test('subtracts local write time and rearms an early timer only for the remainder', async t => {
  let now=0;
  const timers=[];
  t.mock.method(globalThis,'setTimeout',(run,delay)=>{const item={run,delay};timers.push(item);return item;});
  t.mock.method(globalThis,'clearTimeout',()=>{});
  const client=new Client('unused',undefined,10_000,()=>now);
  client.socket={destroyed:false,write(){now=3500;}};
  const pending=assert.rejects(client.send(envelope('account.state',{})),/ack timeout/);
  assert.deepEqual(timers.map(x=>x.delay),[6500]);
  now=9250;timers[0].run();
  assert.deepEqual(timers.map(x=>x.delay),[6500,750]);
  now=10000;timers[1].run();await pending;
  assert.equal(client.pending.size,0);
});

test('a retired timer or old IPC socket cannot consume a replacement entry', async t => {
  let now=0;
  const timers=[];
  t.mock.method(globalThis,'setTimeout',(run,delay)=>{const item={run,delay};timers.push(item);return item;});
  t.mock.method(globalThis,'clearTimeout',()=>{});
  const makeWire=()=>Object.assign(new EventEmitter(),{destroyed:false,write(){}});
  const old=makeWire(), replacement=makeWire(), queue=[old,replacement];
  t.mock.method(net,'createConnection',()=>queue.shift());
  const client=new Client('unused',undefined,10_000,()=>now);
  const oldConnection=client.connect(), report=envelope('account.state',{});
  const retired=assert.rejects(client.send(report),/disconnected; outcome unknown/);
  old.emit('close');await oldConnection;await retired;
  assert.equal(client.socket,undefined);
  await assert.rejects(client.send(report),/disconnected/);
  now=2000;
  const currentConnection=client.connect(), pending=client.send(report);
  old.emit('close');
  assert.equal(client.socket,replacement);
  now=10_000;timers[0].run();
  await client.receive(receipt(report.id,false),old);
  assert.equal(client.pending.size,1);
  await client.receive(receipt(report.id),replacement);
  assert.equal((await pending).ok,true);
  replacement.emit('close');await currentConnection;
  assert.equal(client.pending.size,0);
});

test('settles a synchronous receipt once even when write later throws', async () => {
  const client=new Client('unused',undefined,10_000,()=>0), report=envelope('account.state',{});
  const ack=receipt(report.id);
  client.socket={destroyed:false,write(){void client.receive(ack);throw Error('fixture write');}};
  assert.deepEqual(await client.send(report),ack.payload);
  assert.equal(client.pending.size,0);
  client.socket={destroyed:false,write(){throw Error('fixture write');}};
  await assert.rejects(client.send(report),/send failed; outcome unknown/);
  assert.equal(client.pending.size,0);
});

test('stop rejects the current send without waiting for a transport close event', async () => {
  const client=new Client('unused',undefined,10_000,()=>0), report=envelope('account.state',{});
  let destroys=0, writes=0;
  const wire={destroyed:false,write(){writes++;},destroy(){destroys++;}};
  client.socket=wire;
  const stopped=assert.rejects(client.send(report),/disconnected; outcome unknown/);
  client.stop();client.stop();
  await stopped;
  await client.receive(receipt(report.id),wire);
  await assert.rejects(client.send(report),/disconnected/);
  assert.equal(writes,1);
  assert.equal(destroys,1);
  assert.equal(client.pending.size,0);
});
