import {describe,expect,it} from 'vitest';
import type pg from 'pg';
import {createSmsQuarantineReader} from '../src/db/sms-quarantine-reader.js';

const id='00000000-0000-4000-8000-000000000001';
const meta={id,createdAt:'2026-01-01 00:00:00.123456+00',deviceId:'dev',eventId:'evt',reason:'bad',encoding:'json-utf16le-v1',payloadLength:2,actualLength:2};
const input={actorId:'admin',mode:'export' as const,limit:1,cursor:null,id};
function fake(options:{row?:Record<string,unknown>|null; fail?:string; commit?:string; missingActor?:boolean; payload?:Buffer}={}) {
 const calls:{sql:string;params?:unknown[]}[]=[]; const releases:unknown[]=[];
 const client={query:async(sql:string,params?:unknown[])=>{calls.push({sql,params});if(options.fail && sql.startsWith(options.fail)) throw Error('sensitive database detail');
  if(sql==='COMMIT')return {command:options.commit ?? 'COMMIT',rows:[]};
  if(sql==='ROLLBACK')return {command:'ROLLBACK',rows:[]};
  if(sql.startsWith('SELECT id FROM admin'))return {rows:options.missingActor?[]:[{id:'admin'}]};
  if(sql.startsWith('SELECT payload FROM'))return {rows:[{payload:options.payload ?? Buffer.from([1,2])}]};
  if(sql.startsWith('SELECT id::text'))return {rows: options.row===null?[]:[options.row ?? meta]};
  return {rows:[]};},release:(v?:unknown)=>{releases.push(v);}};
 return {pool:{connect:async()=>client} as unknown as pg.Pool,calls,releases};
}
describe('staged PostgreSQL quarantine reader',()=>{
 it('audits and fetches guarded bytes on one transaction before returning',async()=>{const f=fake();const result=await createSmsQuarantineReader(f.pool)(input);expect(result[0]?.payload).toEqual(Buffer.from([1,2]));expect(f.calls.map(c=>c.sql.split(' ')[0])).toEqual(['BEGIN','SELECT','INSERT','SELECT','SELECT','COMMIT']);expect(f.calls[3]!.sql).toContain('FOR SHARE');expect(f.calls[4]!.sql).toContain('octet_length(payload)<=$2');expect(f.calls[4]!.params).toEqual([id,262144]);expect(f.releases).toEqual([undefined]);});
 it('audits missing and oversized exports without fetching bytes',async()=>{for(const row of [null,{...meta,payloadLength:262145,actualLength:262145}]){const f=fake({row});const result=await createSmsQuarantineReader(f.pool)(input);expect(result.length).toBe(row?1:0);expect(f.calls.some(c=>c.sql.startsWith('INSERT'))).toBe(true);expect(f.calls.some(c=>c.sql.startsWith('SELECT payload FROM'))).toBe(false);expect(f.calls.at(-1)?.sql).toBe('COMMIT');}});
 it('inventory selects bounded metadata only with parameterized pagination',async()=>{const f=fake();const cursor={time:'2026-01-01 00:00:00.123456+00',id};const rows=await createSmsQuarantineReader(f.pool)({actorId:'admin',mode:'inventory',limit:2,cursor});expect(rows[0]?.payload).toBeUndefined();const q=f.calls.find(c=>c.sql.startsWith('SELECT id::text'))!;expect(q.params).toEqual([cursor.time,id,2]);expect(q.sql).toContain('octet_length(device_id)');expect(q.sql).toContain('isfinite(created_at)');expect(q.sql).not.toContain('SELECT payload FROM');});
 it('fails closed on bad metadata, audit failure and unknown commit',async()=>{for(const options of [{row:{...meta,actualLength:3}},{fail:'INSERT'},{fail:'COMMIT'},{commit:'ROLLBACK'},{commit:'unexpected'}]){const f=fake(options);await expect(createSmsQuarantineReader(f.pool)(input)).rejects.toThrow('QUARANTINE_UNAVAILABLE');expect(f.releases).toEqual([true]);}});
 it('does not project bytea in inventory and guards BC and nonfinite timestamps',async()=>{const f=fake();await createSmsQuarantineReader(f.pool)({actorId:'admin',mode:'inventory',limit:2,cursor:null});const sql=f.calls.find(c=>c.sql.startsWith('SELECT id::text'))!.sql;const projection=sql.slice(0,sql.indexOf(' FROM sms_quarantine_record'));expect(projection).not.toMatch(/(?:^|,)\s*(?:\w+\.)?payload\s*(?:,|$)/i);expect(projection).toContain('octet_length(payload)');expect(projection).toContain("created_at >= '0001-01-01 00:00:00+00'");expect(projection).toContain("created_at < '10000-01-01 00:00:00+00'");for(const createdAt of [null,'0001-01-01 00:00:00+00 BC','infinity']){const invalid=fake({row:{...meta,createdAt}});await expect(createSmsQuarantineReader(invalid.pool)(input)).rejects.toThrow('QUARANTINE_UNAVAILABLE');expect(invalid.calls.at(-1)?.sql).toBe('ROLLBACK');}});
 it('fails before audit when actor is absent and rejects inconsistent oversized records',async()=>{const missing=fake({missingActor:true});await expect(createSmsQuarantineReader(missing.pool)(input)).rejects.toThrow('QUARANTINE_UNAVAILABLE');expect(missing.calls.some(c=>c.sql.startsWith('INSERT'))).toBe(false);const mismatch=fake({row:{...meta,payloadLength:262145,actualLength:262146}});await expect(createSmsQuarantineReader(mismatch.pool)(input)).rejects.toThrow('QUARANTINE_UNAVAILABLE');expect(mismatch.calls.some(c=>c.sql.startsWith('SELECT payload FROM'))).toBe(false);expect(mismatch.calls.at(-1)?.sql).toBe('ROLLBACK');});
 it('fetches bytes exactly at the cap',async()=>{const payload=Buffer.alloc(262144);const f=fake({row:{...meta,payloadLength:payload.length,actualLength:payload.length},payload});expect((await createSmsQuarantineReader(f.pool)(input))[0]?.payload).toEqual(payload);expect(f.calls.find(c=>c.sql.startsWith('SELECT payload FROM'))?.params).toEqual([id,262144]);});
 it('rejects invalid requests without acquiring a client',async()=>{const f=fake();await expect(createSmsQuarantineReader(f.pool)({...input,id:'bad'})).rejects.toThrow('QUARANTINE_UNAVAILABLE');expect(f.calls).toEqual([]);});
});
