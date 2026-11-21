import {createHash} from 'node:crypto';
import Fastify from 'fastify';
import type pg from 'pg';
import {expect, it, vi} from 'vitest';
import {createRecoverableSmsQuarantineReader} from '../src/db/sms-quarantine-reader.js';
import {registerRecoverableSmsQuarantineInventory} from '../src/http/sms-quarantine-inventory.js';
import {canonicalSmsEnvelope, type ParsedSmsEnvelope} from '../src/devices/sms-quarantine-envelope.js';

const id='00000000-0000-4000-8000-000000000001';
const other='00000000-0000-4000-8000-000000000002';
const deviceId='dev_00000000000000000000000001';
const event: ParsedSmsEnvelope={v:1,type:'sms.received',id:'evt_00000000000000000000000001',ts:42,
  payload:{subId:null,slot:null,from:'fixture',fromKind:'unknown',body:'fixture',receivedAt:37,parts:2 ** 31}};
const bytes=canonicalSmsEnvelope(event);
const createdAt='2026-01-01 00:00:00.123456+00';
const row={id,deviceId,eventId:event.id,deviceTsMs:'42',createdAt,linked:true,reason:'parts-out-of-range',
  encoding:'json-utf16le-v1',payloadLength:bytes.length,payload:bytes,digest:createHash('sha256').update(bytes).digest()};
const token='test-session-token';
const headers={authorization:'Bearer '+token};
const inventory='/api/admin/sms-quarantine';
const exportUrl=inventory+'/'+id+'/export';

function setup(options: {authorized?:boolean; live?:boolean; rows?:typeof row[]; fail?:'audit'|'commit'; tag?:string} = {}) {
  const query=vi.fn(async (sql:string, params:unknown[] = []) => {
    if (sql.startsWith('SELECT NOT pg_is_in_recovery()')) return {rows:[{ready:true}]};
    if (sql.startsWith('SELECT id FROM admin')) return {rows:[{id:'admin'}]};
    if (sql.startsWith('SELECT admin_id FROM admin_session')) return {rows:[{admin_id:'admin'}]};
    if (sql.startsWith('SELECT 1 FROM admin_session')) return {rows:options.live===false?[]:[{}]};
    if (sql.includes('FROM sms_received_quarantine q')) return {rows:options.rows??[row]};
    if (sql.startsWith('INSERT INTO sms_received_quarantine_access')) {
      if (options.fail==='audit') throw Error('private audit detail');
      return {rowCount:1,rows:[]};
    }
    if (sql==='COMMIT' && options.fail==='commit') throw Error('private commit detail');
    if (sql==='COMMIT' || sql==='ROLLBACK') return {command:sql==='COMMIT'?options.tag??sql:sql,rows:[]};
    if (sql==='BEGIN' || sql.startsWith('SET ')) return {rows:[]};
    throw Error('unhandled mock SQL '+String(params.length));
  });
  const pool={connect:async()=>({query,release:vi.fn()})} as unknown as pg.Pool;
  const app=Fastify();
  registerRecoverableSmsQuarantineInventory(app,{authenticate:async candidate=>candidate===token?'admin':null,
    authorize:()=>options.authorized!==false,auditAndRead:createRecoverableSmsQuarantineReader(pool)});
  return {app,query};
}

it('withholds recovery metadata and bytes without an authorized live session',async () => {
  const denied=setup({authorized:false});
  const revoked=setup({live:false});
  try {
    expect((await denied.app.inject({url:inventory})).statusCode).toBe(401);
    expect((await denied.app.inject({url:exportUrl,headers})).statusCode).toBe(403);
    expect(denied.query).not.toHaveBeenCalled();
    const response=await revoked.app.inject({url:exportUrl,headers});
    expect(response.statusCode).toBe(401);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(revoked.query.mock.calls.some(([sql])=>sql.includes('sms_received_quarantine'))).toBe(false);
    const [sessionSql, sessionArgs]=revoked.query.mock.calls.find(([sql])=>sql.startsWith('SELECT admin_id'))!;
    expect(sessionSql).toContain('FOR SHARE');
    expect(sessionArgs).toEqual([createHash('sha256').update(token).digest(),'admin']);
    expect(JSON.stringify(revoked.query.mock.calls)).not.toContain(token);
  } finally { await Promise.all([denied.app.close(),revoked.app.close()]); }
});

it('returns only metadata in the inventory and preserves the cursor microseconds',async () => {
  const f=setup({rows:[row,{...row,id:other,linked:false}]});
  try {
    const response=await f.app.inject({url:inventory+'?limit=1',headers});
    expect(response.statusCode).toBe(200);
    expect(response.body).not.toContain('payloadBase64');
    expect(response.json().data).toEqual([{id,deviceId,eventId:event.id,deviceTs:42,createdAt,state:'retained',
      encoding:'json-utf16le-v1',reason:'parts-out-of-range',payloadLength:bytes.length}]);
    const nextCursor=response.json().nextCursor;
    expect(JSON.parse(Buffer.from(nextCursor,'base64url').toString('utf8'))).toEqual({time:createdAt,id});
    await f.app.inject({url:inventory+'?limit=1&cursor='+nextCursor,headers});
    const selected=f.query.mock.calls.filter(([sql])=>sql.includes('FROM sms_received_quarantine q'));
    expect(selected[0]?.[0]).not.toMatch(/q\.(payload|digest)\b/);
    expect(selected[1]?.[1]).toEqual([2,createdAt,id]);
    const both=await f.app.inject({url:inventory,headers});
    expect(both.json().data[1].state).toBe('needs_attention');
  } finally { await f.app.close(); }
});

it('exports exact verified bytes only with a confirmed audit transaction',async () => {
  const f=setup();
  try {
    const response=await f.app.inject({url:exportUrl,headers});
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(Buffer.from(response.json().data[0].payloadBase64,'base64')).toEqual(bytes);
    const audit=f.query.mock.calls.find(([sql])=>sql.startsWith('INSERT INTO sms_received_quarantine_access'));
    expect(audit?.[1]).toEqual(['admin','export','ok',id,null,null,1,1]);
    expect(f.query.mock.calls.at(-1)?.[0]).toBe('COMMIT');
  } finally { await f.app.close(); }
  for (const options of [{fail:'audit'},{fail:'commit'},{tag:'ROLLBACK'}] as const) {
    const broken=setup(options);
    try {
      const response=await broken.app.inject({url:exportUrl,headers});
      expect(response.statusCode).toBe(503);
      expect(response.body).not.toMatch(/private|payloadBase64/);
    } finally { await broken.app.close(); }
  }
});

it('audits missing or damaged records and returns no bytes',async () => {
  for (const [rows,outcome,code] of [
    [[], 'missing', 404],
    [[{...row,linked:false}], 'invalid', 503],
    [[{...row,digest:Buffer.alloc(32)}], 'invalid', 503],
  ] as const) {
    const f=setup({rows:[...rows]});
    try {
      const response=await f.app.inject({url:exportUrl,headers});
      expect(response.statusCode).toBe(code);
      expect(response.body).not.toContain('payloadBase64');
      const audit=f.query.mock.calls.find(([sql])=>sql.startsWith('INSERT INTO sms_received_quarantine_access'));
      expect(audit?.[1]).toEqual(['admin','export',outcome,id,null,null,1,rows.length]);
    } finally { await f.app.close(); }
  }
});
