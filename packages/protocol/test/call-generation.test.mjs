import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseDeviceMessage } from '../dist/index.js';

test('generation fixtures preserve identity and legacy messages remain valid', async () => {
 const cases=JSON.parse(await readFile(new URL('../fixtures/device/call-generation.json',import.meta.url),'utf8'));
 for(const {direction,valid} of cases) {
  assert.deepEqual(parseDeviceMessage(valid,direction),valid);
  const payload={...valid.payload}; delete payload.generation; delete payload.capabilities;
  const legacy={...valid,payload}; assert.deepEqual(parseDeviceMessage(legacy,direction),legacy);
 }
 const base=cases.find(c=>c.valid.type==='call.reject').valid;
 for(const generation of ['',null,3,'gen_81ARZ3NDEKTSV4RRFFQ69G5FAV','gen_01arz3ndektsv4rrffq69g5fav'])
  assert.throws(()=>parseDeviceMessage({...base,payload:{...base.payload,generation}},'command'));
 const hello=cases[0].valid;
 assert.throws(()=>parseDeviceMessage({...hello,payload:{...hello.payload,capabilities:{callGeneration:'true'}}},'event'));
});

test('generation survives every call command and rejects malformed identities',()=>{
 const id='01ARZ3NDEKTSV4RRFFQ69G5FAV';
 const common={callId:'cal_'+id,generation:'gen_'+id};
 const media={sessionId:'ses_'+id,legId:'leg_'+id,path:'/media',format:2};
 const payloads={'call.dial':{...common,subId:null,slot:0,to:'1',media},'call.answer':{...common,media},'call.reject':common,'call.hangup':common,'call.dtmf':{...common,digits:'1#'}};
 for(const [type,payload] of Object.entries(payloads)) {
  const msg={v:1,type,id:'cmd_'+id,ts:1,payload};
  assert.deepEqual(parseDeviceMessage(msg,'command'),msg);
  assert.throws(()=>parseDeviceMessage({...msg,payload:{...payload,generation:'bad'}},'command'));
 }
});
