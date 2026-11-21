import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { id as idSchema, parseDeviceMessage, parseAdapterMessage, decodeAdapterJson, encodeAdapterJson, devicePayloads, adapterPayloads, adminEvent, adminEventTypes } from '../dist/index.js';
const load = async name => JSON.parse(await readFile(new URL('../fixtures/'+name+'.json',import.meta.url),'utf8'));
for (const [name,parse,expected] of [['device/messages',(v,d)=>parseDeviceMessage(v,d),Object.keys(devicePayloads)],['ipc/messages',parseAdapterMessage,Object.keys(adapterPayloads)],['admin/events',v=>adminEvent.parse(v),adminEventTypes]]) {
 test(name+' covers each type',async()=>{ const cases=await load(name); assert.deepEqual([...new Set(cases.map(c=>c.valid.type))].sort(),[...expected].sort()); for(const c of cases) {assert.deepEqual(parse(c.valid,c.direction),c.valid); assert.throws(()=>parse(c.invalid,c.direction));} });
}
test('heartbeat accepts unknown observations and retains old enum values',async()=>{
 const message=await load('device/heartbeat.unknown.valid');
 assert.deepEqual(parseDeviceMessage(message,'event'),message);
 for(const network of ['wifi','cellular','none','unknown']) for(const shizuku of ['running','stopped','not_installed','unsupported','unknown']) {
  const sample={...message,payload:{...message.payload,network,shizuku}};
  assert.deepEqual(parseDeviceMessage(sample,'event'),sample);
 }
 for(const field of ['network','shizuku']) assert.throws(()=>parseDeviceMessage({...message,payload:{...message.payload,[field]:'invalid'}},'event'));
});
test('SMS result reserves the Core conflict code',()=>{
 const base={v:1,type:'sms.result',id:'evt_01ARZ3NDEKTSV4RRFFQ69G5FAV',ts:1,payload:{taskId:'tsk_01ARZ3NDEKTSV4RRFFQ69G5FAV',state:'failed',errorCode:'SMS_RESULT_CONFLICT'}};
 assert.throws(()=>parseDeviceMessage(base,'event'));
 assert.doesNotThrow(()=>parseDeviceMessage({...base,payload:{...base.payload,errorCode:'SMS_SEND_FAILED'}},'event'));
});
test('admin device event accepts unknown status observations',async()=>{
 const message=await load('admin/device.unknown.valid');
 assert.deepEqual(adminEvent.parse(message),message);
});
test('canonical ULID boundaries apply to envelope and nested identifiers',async()=>{
 const cases=await load('ulid-boundaries');
 for(const item of cases) {
  assert.equal(idSchema('dev').safeParse(item.id).success,item.valid,item.id);
  const suffix=item.id.slice(4);
  const event={v:1,type:'hello',id:'evt_'+suffix,ts:1,payload:{token:'x',apkVersion:'1',apkCode:1,protocol:1,manufacturer:'x',model:'x',apiLevel:30,locale:'en'}};
  const adapter={v:1,type:'call.hangup',id:'ipc_01ARZ3NDEKTSV4RRFFQ69G5FAV',ts:1,payload:{callId:'cal_'+suffix}};
  for(const parse of [()=>parseDeviceMessage(event,'event'),()=>parseAdapterMessage(adapter)]) {
   if(item.valid) assert.doesNotThrow(parse); else assert.throws(parse);
  }
 }
});
test('device and adapter ACKs require consistent ok and error', () => {
 const suffix='01ARZ3NDEKTSV4RRFFQ69G5FAV';
 const cases=[
  {id:'evt_'+suffix,parse:v=>parseDeviceMessage(v,'event')},
  {id:'cmd_'+suffix,parse:v=>parseDeviceMessage(v,'command')},
  {id:'ipc_'+suffix,parse:parseAdapterMessage},
 ];
 for(const {id,parse} of cases) for(const [ok,error,valid] of [[true,null,true],[false,'BAD_MESSAGE',true],[true,'BAD_MESSAGE',false],[false,null,false]]) {
  const message={v:1,type:'ack',id,ts:1,payload:{refId:'ref',ok,error}};
  if(valid) assert.deepEqual(parse(message),message); else assert.throws(()=>parse(message));
 }
});
test('UTF-8 accepts multilingual content and rejects malformed sequences',async()=>{const cases=await load('ipc/messages'); const msg=cases.find(c=>c.valid.type==='message.received').valid; assert.deepEqual(decodeAdapterJson(encodeAdapterJson(msg)),msg); for(const bytes of [[0xc0,0xaf],[0xed,0xa0,0x80],[0xf4,0x90,0x80,0x80],[0xe2,0x82]]) assert.throws(()=>decodeAdapterJson(Uint8Array.from(bytes)));});
