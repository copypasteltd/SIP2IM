import test from 'node:test';
import assert from 'node:assert/strict';
import { createDevice, snapshot } from './device.mjs';
import { parseDeviceMessage } from '../../packages/protocol/dist/device.js';

test('snapshot probe timestamps share the injected event clock and satisfy protocol', () => {
 for (const simCount of [1, 2]) {
  const event=createDevice({token:'x',simCount,now:()=>1700000000123}).snapshot();
  assert.deepEqual(parseDeviceMessage(event,'event'),event);
  assert.equal(event.payload.sims.length,simCount);
  for (const probe of Object.values(event.payload.probes)) assert.deepEqual(probe,{result:'untested',probedAt:event.ts,detail:null});
  const invalid=structuredClone(event); invalid.payload.probes.dial.probedAt=null;
  assert.throws(()=>parseDeviceMessage(invalid,'event'));
 }
});
test('hello, heartbeat and one/two SIM snapshots match contract', () => {
 const d=createDevice({token:'secret',simCount:2,now:()=>100});
 assert.match(d.hello().id,/^evt_[0-9A-HJKMNP-TV-Z]{26}$/); assert.equal(d.hello().payload.protocol,1); assert.equal(d.heartbeat().payload.paused,false); assert.equal(d.snapshot().payload.sims.length,2); assert.throws(()=>snapshot(3));
});
test('default simulator does not claim Shizuku or accept a generation-bound dial', () => {
  const device = createDevice({ token: 'fixture' });
  assert.equal(device.hello().payload.capabilities, undefined);
  assert.equal(device.heartbeat().payload.shizuku, 'unknown');
  let opens = 0;
  const legacy = {
    v: 1, id: 'cmd_same', type: 'call.dial', payload: { callId: 'cal_' + '1'.repeat(26), media: {} },
  };
  const versioned = { ...legacy, payload: { ...legacy.payload, generation: 'gen_' + '1'.repeat(26) } };
  const [legacyAck] = device.command(legacy, () => { opens++; });
  assert.equal(legacyAck.payload.ok, true);
  const [ack, ...events] = device.command(versioned, () => { opens++; });
  assert.deepEqual(ack.payload, { refId: legacy.id, ok: false, error: 'CAPABILITY_UNSUPPORTED' });
  assert.deepEqual(events, []);
  assert.deepEqual(device.command(versioned, () => { opens++; }), [ack]);
  assert.deepEqual(device.command(legacy, () => { opens++; }), [legacyAck]);
  assert.equal(opens, 1);
});

test('commands ack once and replay cached ack without repeated actions', () => {
 const d=createDevice({token:'x'}); const c={v:1,id:'cmd_1',type:'sms.send',payload:{taskId:'t',subId:1,slot:0,to:'1',body:'hi'}};
 const first=d.command(c); assert.deepEqual(first.map(x=>x.type),['ack','sms.result']); assert.deepEqual(d.command(c),[first[0]]);
});
test('call state transitions and error codes', () => {
 const d=createDevice({token:'x'}); d.incoming('c');
 assert.deepEqual(d.command({v:1,id:'cmd_2',type:'call.answer',payload:{callId:'c',media:{}}}).map(x=>x.type),['ack']);
 assert.equal(d.command({v:1,id:'cmd_3',type:'call.hangup',payload:{callId:'c'}})[1].payload.cause,'local_hangup');
 const dial=d.command({v:1,id:'cmd_4',type:'call.dial',payload:{callId:'d',media:{}}}); assert.deepEqual(dial.slice(1).map(x=>x.payload.state),['dialing']);
 assert.equal(d.command({v:1,id:'cmd_5',type:'call.dial',payload:{callId:'e',media:{}}})[0].payload.error,'DEVICE_BUSY');
});
