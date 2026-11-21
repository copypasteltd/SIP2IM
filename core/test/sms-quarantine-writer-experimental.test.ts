import {describe,it,expect} from 'vitest';
import type pg from 'pg';
import {experimentalQuarantineSms} from '../src/db/sms-quarantine-writer-experimental.js';
import {canonicalSmsEnvelope} from '../src/devices/sms-quarantine-envelope.js';

const event={v:1 as const,type:'sms.received' as const,id:'evt_01ARZ3NDEKTSV4RRFFQ69G5FAV',ts:1700000000000,payload:{subId:null,slot:null,from:'peer',fromKind:'unknown' as const,body:'x\u0000\ud800',receivedAt:1700000000000,parts:1}};
function fake(mode:'insert'|'duplicate'|'missing'|'conflict'|'alert-failure'|'commit-failure'|'release-failure') {
 const calls:string[]=[];
 const query=async (sql:string) => { calls.push(sql);
  if(sql==='COMMIT') {if(mode==='commit-failure') throw Error('sensitive');return {command:'COMMIT',rows:[]};}
  if(sql==='ROLLBACK') return {command:'ROLLBACK',rows:[]};
  if(sql.startsWith('SELECT id FROM device')) return {rows:[{id:'device'}]};
  if(sql.startsWith('INSERT INTO device_event')) return {rows:mode==='insert'||mode==='alert-failure'||mode==='commit-failure'||mode==='release-failure'?[{id:event.id}]:[]};
  if(sql.startsWith('SELECT device_id=')) return {rows:[{matches:mode!=='conflict',custody_kind:'sms_quarantine'}]};
  if(sql.startsWith('SELECT q.device_id')) return {rows:mode==='missing'?[]:[{device_id:'device',encoding:'json-utf16le-v1',reason:'postgres-invalid-string',payload:canonicalSmsEnvelope(event),payload_length:canonicalSmsEnvelope(event).length,alerted:true}]};
  if(sql.startsWith('SELECT event_id FROM sms_quarantine_alert')) return {rows:[{event_id:event.id}]};
  if(sql.startsWith('INSERT INTO sms_quarantine_alert') && mode==='alert-failure') throw Error('sensitive');
  return {rows:[]};
 };
 return {pool:{connect:async()=>({query,release:()=>{if(mode==='release-failure') throw Error('sensitive');}})} as unknown as pg.Pool,calls};
}
describe('unwired quarantine transaction',()=>{
 it('writes parent, child, alert then commits',async()=>{const f=fake('insert');expect(await experimentalQuarantineSms(f.pool,'device',event)).toBe('inserted');expect(f.calls.filter(q=>q.startsWith('INSERT')).length).toBe(3);expect(f.calls.at(-1)).toBe('COMMIT');});
 it('recognizes only an exact committed duplicate',async()=>{const f=fake('duplicate');expect(await experimentalQuarantineSms(f.pool,'device',event)).toBe('duplicate');expect(await experimentalQuarantineSms(fake('duplicate').pool,'device',{...event,payload:{...event.payload,body:'different\u0000'}})).toBe('rejected');});
 it('rejects missing child and conflicting identity',async()=>{for(const mode of ['missing','conflict'] as const) expect(await experimentalQuarantineSms(fake(mode).pool,'device',event)).toBe('rejected');});
 it('rolls back on alert failure and hides errors',async()=>{const f=fake('alert-failure');await expect(experimentalQuarantineSms(f.pool,'device',event)).rejects.toThrow('EXPERIMENTAL_QUARANTINE_UNAVAILABLE');expect(f.calls.at(-1)).toBe('ROLLBACK');});
 it('fails closed on release failure',async()=>{await expect(experimentalQuarantineSms(fake('release-failure').pool,'device',event)).rejects.toThrow('EXPERIMENTAL_QUARANTINE_UNAVAILABLE');});
 it('rejects an oversized encoded envelope',async()=>{const f=fake('insert');expect(await experimentalQuarantineSms(f.pool,'device',{...event,payload:{...event.payload,body:'x'.repeat(140000)+'\u0000'}})).toBe('rejected');expect(f.calls).toHaveLength(0);});
 it('fails closed on uncertain commit',async()=>{const f=fake('commit-failure');await expect(experimentalQuarantineSms(f.pool,'device',event)).rejects.toThrow('EXPERIMENTAL_QUARANTINE_UNAVAILABLE');expect(f.calls.at(-1)).toBe('ROLLBACK');});
});
