import {describe,it,expect} from 'vitest';
import {decodeQuarantinePayload,encodeQuarantinePayload,hasPostgresInvalidString} from '../src/devices/sms-quarantine-codec.js';

describe('quarantine codec foundation',()=>{
 it.each(['\0','a\0b','\ud800','\udc00','a\ud800b','😀\0x'])('round trips exact UTF-16 units %#',body=>{
  const value={from:'peer',body,nested:['\udfff',{'\0':'x'}]};
  expect(decodeQuarantinePayload(encodeQuarantinePayload(value))).toEqual(value);
  expect(hasPostgresInvalidString(value)).toBe(true);
 });
 it.each(['','literal \\u0000','é','😀','a\ud800\udc00z'])('accepts valid PostgreSQL strings %#',value=>expect(hasPostgresInvalidString(value)).toBe(false));
 it('rejects values that JSON serialization would change',()=>{
  const cycle: {self?:unknown}={}; cycle.self=cycle;
  for(const value of [undefined,NaN,Infinity,-0,1n,new Date(),{x:undefined},[undefined],Array(1),cycle,{toJSON:()=>1},Object.defineProperty({},'x',{get:()=>1,enumerable:true})]) {
   expect(()=>encodeQuarantinePayload(value)).toThrow();
  }
 });
 it('rejects truncated bytes and malformed JSON',()=>{
  expect(()=>decodeQuarantinePayload(Buffer.from([1]))).toThrow();
  expect(()=>decodeQuarantinePayload(Buffer.from('{','utf16le'))).toThrow();
 });
});
