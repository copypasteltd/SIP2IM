import {describe,it,expect} from 'vitest';
import {parseDeviceMessage} from '@voipgw/protocol';
import {canonicalSmsEnvelope,encodeSmsCustodyEnvelope,smsQuarantineReasons,type ParsedSmsEnvelope} from '../src/devices/sms-quarantine-envelope.js';
import {decodeQuarantinePayload} from '../src/devices/sms-quarantine-codec.js';

const base=():ParsedSmsEnvelope=>({v:1,type:'sms.received',id:'evt_01ARZ3NDEKTSV4RRFFQ69G5FAV',ts:10,payload:{subId:null,slot:0,from:'123',fromKind:'short',body:'ok',receivedAt:9,parts:1}});
describe('parsed SMS quarantine envelope',()=>{
 it('preserves the complete parsed envelope including NUL and isolated UTF-16 surrogates',()=>{
  const event=base(); event.payload.from='a\0b'; event.payload.body='😀\ud800\udfff\udc00'; event.payload.parts=2147483648;
  expect(smsQuarantineReasons(event)).toEqual(['postgres-invalid-string','parts-out-of-range']);
  expect(decodeQuarantinePayload(canonicalSmsEnvelope(event))).toEqual(event);
 });
 it('round trips all parsed scalar fields and preserves signed zero in custody bytes',()=>{
  const codeUnits=['\0','\u001f','\\','"','\ud800','\udfff','😀','é','́','\u2028'];
  for(const first of codeUnits) for(const second of codeUnits){
   const event=base();
   event.ts=-0;
   event.payload={subId:-0,slot:-0,from:second+first,fromKind:'unknown',body:first+second,receivedAt:-0,parts:2**53};
   const decoded=decodeQuarantinePayload(encodeSmsCustodyEnvelope(event));
   expect(decoded).toStrictEqual(event);
   const unsigned={...event,ts:0,payload:{...event.payload,subId:0,slot:0,receivedAt:0}};
   expect(canonicalSmsEnvelope(decoded as ParsedSmsEnvelope)).toEqual(canonicalSmsEnvelope(unsigned));
  }
 });
 it('classifies only unrepresentable strings and int4 overflow',()=>{
  const event=base(); event.payload.body='literal \\u0000 😀'; event.payload.parts=2147483647;
  expect(smsQuarantineReasons(event)).toEqual([]);
  event.payload.body='\ud800'; expect(smsQuarantineReasons(event)).toEqual(['postgres-invalid-string']);
  event.payload.body='x'; event.payload.parts=2147483648; expect(smsQuarantineReasons(event)).toEqual(['parts-out-of-range']);
 });
 it('normalizes property order and negative zero while preserving all parsed fields',()=>{
  const original=base();
  const parsed=parseDeviceMessage({payload:{parts:1,receivedAt:9,body:'ok',fromKind:'short',from:'123',slot:-0,subId:null,ignored:'discarded'},ts:10,id:original.id,type:'sms.received',v:1,ignored:true},'event') as ParsedSmsEnvelope;
  expect(canonicalSmsEnvelope(parsed).equals(canonicalSmsEnvelope(original))).toBe(true);
  expect(decodeQuarantinePayload(canonicalSmsEnvelope(parsed))).toEqual(original);
  parsed.payload.body='changed'; expect(canonicalSmsEnvelope(parsed).equals(canonicalSmsEnvelope(original))).toBe(false);
 });
 it('retains protocol-accepted large parsed numbers',()=>{
  const event=base(); event.payload.parts=2**53; event.payload.subId=2**53;
  const parsed=parseDeviceMessage(event,'event') as ParsedSmsEnvelope;
  expect(decodeQuarantinePayload(canonicalSmsEnvelope(parsed))).toEqual(parsed);
  expect(smsQuarantineReasons(parsed)).toEqual(['parts-out-of-range']);
 });
 it('distinguishes each parsed identity and payload field; device identity is external',()=>{
  const event=base();
  const variants:ParsedSmsEnvelope[]=[
   {...event,id:'evt_01ARZ3NDEKTSV4RRFFQ69G5FAW'}, {...event,ts:11},
   ...Object.entries({subId:1,slot:null,from:'124',fromKind:'unknown',body:'changed',receivedAt:8,parts:2})
    .map(([key,value])=>({...event,payload:{...event.payload,[key]:value}}) as ParsedSmsEnvelope),
  ];
  const bytes=canonicalSmsEnvelope(event);
  for(const variant of variants) expect(canonicalSmsEnvelope(variant).equals(bytes)).toBe(false);
  // The authenticated device ID is deliberately not in these bytes; callers must compare it separately.
 });
});
