import type {FastifyInstance} from 'fastify';
import {validPgTimestamp} from '../util/cursor.js';
import {MAX_SMS_QUARANTINE_BYTES} from '../devices/sms-quarantine-codec.js';

// Staged only: the caller must supply an atomic audit-and-read transaction.
export type QuarantineRow = {id:string; createdAt:string; deviceId:string; eventId:string; reason:string; encoding:'json-utf16le-v1'; payloadLength:number; payload?:Buffer};
export type QuarantineRead = (input:{actorId:string; mode:'inventory'|'export'; limit:number; cursor:{time:string;id:string}|null; id?:string})=>Promise<QuarantineRow[]>;
const err=(code:string)=>({error:{code,message:code,details:null}});
const idPattern=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
function cursorDecode(s:string):{time:string;id:string} {
 if(s.length>512||!/^[A-Za-z0-9_-]+$/.test(s)) throw Error('BAD_CURSOR');
 const bytes=Buffer.from(s,'base64url'); if(bytes.toString('base64url')!==s) throw Error('BAD_CURSOR');
 const v:unknown=JSON.parse(bytes.toString('utf8'));
 if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).sort().join(',')!=='id,time') throw Error('BAD_CURSOR');
 const c=v as {time:unknown;id:unknown}; if(!validPgTimestamp(c.time)||typeof c.id!=='string'||!idPattern.test(c.id)) throw Error('BAD_CURSOR');
 return {time:c.time,id:c.id};
}
export function registerSmsQuarantineInventory(app:FastifyInstance, deps:{authenticate:(token:string)=>Promise<string|null>; auditAndRead?:QuarantineRead}):void {
 for(const mode of ['inventory','export'] as const) app.get('/api/admin/sms-quarantine'+(mode==='export'?'/:id/export':''),async(req,reply)=>{
  reply.header('Cache-Control','no-store').header('Pragma','no-cache');
  const match=/^Bearer (.+)$/.exec(req.headers.authorization??'');
  let actorId:string|null=null; try { if(match) actorId=await deps.authenticate(match[1]!); } catch { return reply.code(503).send(err('QUARANTINE_UNAVAILABLE')); }
  if(!actorId) return reply.code(401).send(err('UNAUTHORIZED'));
  const q=req.query as Record<string,unknown>; const id=mode==='export'?(req.params as {id:string}).id:undefined; if(id&&!idPattern.test(id)) return reply.code(400).send(err('BAD_REQUEST')); let limit=25; let cursor:null|{time:string;id:string}=null;
  try {
   if(mode==='export'&&Object.keys(q).length) throw Error(); if(Object.keys(q).some(k=>k!=='limit'&&k!=='cursor')) throw Error();
   if(q.limit!==undefined) {if(typeof q.limit!=='string'||!/^(?:[1-9]|[1-4][0-9]|50)$/.test(q.limit)) throw Error(); limit=Number(q.limit);}
   if(q.cursor!==undefined) {if(typeof q.cursor!=='string') throw Error();cursor=cursorDecode(q.cursor);}
  } catch {return reply.code(400).send(err('BAD_REQUEST'));}
  try {
   if(!deps.auditAndRead) throw Error();
   const rows=await deps.auditAndRead({actorId,mode,limit:mode==='export'?1:limit+1,cursor,...(id?{id}:{})});
   if(rows.length>(mode==='export'?1:limit+1)|| (id&&rows.some(r=>r.id!==id))) throw Error(); if(mode==='export'&&rows.length===0) return reply.code(404).send(err('NOT_FOUND'));
   for(const r of rows) if(typeof r.id!=='string'||!idPattern.test(r.id)||!validPgTimestamp(r.createdAt)||typeof r.deviceId!=='string'||r.deviceId.length===0||r.deviceId.length>256||typeof r.eventId!=='string'||r.eventId.length===0||r.eventId.length>256||typeof r.reason!=='string'||r.reason.length===0||r.reason.length>256||r.encoding!=='json-utf16le-v1'||!Number.isSafeInteger(r.payloadLength)||r.payloadLength<0||(mode==='export'&&r.payloadLength<=262144&&(!Buffer.isBuffer(r.payload)||r.payload.length!==r.payloadLength))) throw Error();
   if(mode==='export'&&rows[0]!.payloadLength>262144) return reply.code(413).send(err('QUARANTINE_EXPORT_TOO_LARGE'));
   const page=rows.slice(0,limit); const last=page.at(-1);
   const nextCursor=mode==='inventory'&&rows.length>limit&&last?Buffer.from(JSON.stringify({time:last.createdAt,id:last.id})).toString('base64url'):null;
   return {data:page.map(r=>({id:r.id,createdAt:r.createdAt,deviceId:r.deviceId,eventId:r.eventId,reason:r.reason,encoding:r.encoding,payloadLength:r.payloadLength,...(mode==='export'?{payloadBase64:r.payload!.toString('base64')}: {})})),nextCursor};
  } catch {return reply.code(503).send(err('QUARANTINE_UNAVAILABLE'));}
 });
}

export interface RecoverableQuarantineRow extends QuarantineRow {
  deviceTs: number;
  state: 'retained' | 'needs_attention';
}
type QuarantineMode = 'inventory' | 'export';
type QuarantineInput = Parameters<QuarantineRead>[0];
export type RecoverableQuarantineRead = (input: QuarantineInput, bearer: string) => Promise<
  {status: 'ok'; rows: RecoverableQuarantineRow[]} | {status: 'denied' | 'missing' | 'invalid'}
>;

function queryPage(query: Record<string, unknown>, mode: QuarantineMode): {limit:number; cursor:QuarantineInput['cursor']} {
  const keys = Object.keys(query);
  if ((mode === 'export' && keys.length > 0) || keys.some(key => key !== 'limit' && key !== 'cursor')) throw Error();
  const {limit, cursor} = query;
  if (limit !== undefined && (typeof limit !== 'string' || !/^(?:[1-9]|[1-4][0-9]|50)$/.test(limit))) throw Error();
  if (cursor !== undefined && typeof cursor !== 'string') throw Error();
  return {limit:limit === undefined ? 25 : Number(limit), cursor:cursor === undefined ? null : cursorDecode(cursor)};
}

/** Deploy only with the custody schema and an explicit operator authorization policy. */
export function registerRecoverableSmsQuarantineInventory(app: FastifyInstance, deps: {
  authenticate(token: string): Promise<string | null>;
  authorize(actorId: string, mode: QuarantineMode): boolean | Promise<boolean>;
  auditAndRead: RecoverableQuarantineRead;
}): void {
  for (const mode of ['inventory','export'] as const) {
    const path = mode === 'export' ? '/api/admin/sms-quarantine/:id/export' : '/api/admin/sms-quarantine';
    app.get<{Params:{id?:string}}>(path, {exposeHeadRoute:false}, async (req, reply) => {
      reply.header('Cache-Control','no-store').header('Pragma','no-cache')
        .header('X-Content-Type-Options','nosniff');
      const bearer = /^Bearer ([^\s,]{1,4096})$/.exec(req.headers.authorization ?? '')?.[1];
      if (!bearer) return reply.code(401).send(err('UNAUTHORIZED'));
      try {
        const actorId = await deps.authenticate(bearer);
        if (!actorId) return reply.code(401).send(err('UNAUTHORIZED'));
        if (await deps.authorize(actorId,mode) !== true) return reply.code(403).send(err('FORBIDDEN'));
        const id = req.params.id;
        let page: ReturnType<typeof queryPage>;
        try {
          if (mode === 'export' && (id?.length !== 36 || !idPattern.test(id))) throw Error();
          page = queryPage(req.query as Record<string,unknown>,mode);
        } catch { return reply.code(400).send(err('BAD_REQUEST')); }
        const result = await deps.auditAndRead({actorId,mode,limit:mode==='export'?1:page.limit+1,cursor:page.cursor,
          ...(mode==='export'?{id}:{})},bearer);
        if (result.status === 'denied') return reply.code(401).send(err('UNAUTHORIZED'));
        if (mode === 'export' && result.status === 'missing') return reply.code(404).send(err('NOT_FOUND'));
        if (result.status !== 'ok') throw Error();
        const rows = result.rows;
        const selected = rows[0];
        if (mode === 'export' && (rows.length !== 1 || selected?.id !== id || selected?.state !== 'retained' ||
            !Buffer.isBuffer(selected?.payload) || selected.payload.length !== selected.payloadLength ||
            selected.payload.length > MAX_SMS_QUARANTINE_BYTES)) throw Error();
        if (mode === 'inventory' && rows.length > page.limit + 1) throw Error();
        const visible = rows.slice(0,page.limit);
        const last = visible.at(-1);
        const nextCursor = mode === 'inventory' && rows.length > page.limit && last
          ? Buffer.from(JSON.stringify({time:last.createdAt,id:last.id})).toString('base64url') : null;
        return {data:visible.map(row=>({id:row.id,createdAt:row.createdAt,deviceId:row.deviceId,eventId:row.eventId,
          deviceTs:row.deviceTs,reason:row.reason,encoding:row.encoding,payloadLength:row.payloadLength,state:row.state,
          ...(mode==='export'?{payloadBase64:row.payload!.toString('base64')}: {})})),nextCursor};
      } catch { return reply.code(503).send(err('QUARANTINE_UNAVAILABLE')); }
    });
  }
}
