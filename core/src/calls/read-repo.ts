import type pg from 'pg';
import type { adminCallLeg, cellCallState } from '@voipgw/protocol';
import {validPgTimestamp} from '../util/cursor.js';

type AdminLegState = typeof adminCallLeg._output['state'];
type CellLegState = (typeof cellCallState.options)[number];
// Read-only projection: the database and call events retain the original state.
// Alerting has no defined admin equivalent; unrecognized values also become unknown.
// Active/disconnected are backed by the writer's connected_at/ended_at transitions.
const cellLegProjection: Record<CellLegState, AdminLegState> = {
  ringing:'ringing', dialing:'dialing', alerting:'unknown', active:'connected', disconnected:'ended',
};
const adminLegProjection: Record<AdminLegState, AdminLegState> = {
  created:'created', dialing:'dialing', ringing:'ringing', connected:'connected', ended:'ended', failed:'failed', unknown:'unknown',
};
function projectLegState(state: unknown): AdminLegState {
  if(typeof state !== 'string') return 'unknown';
  if(Object.hasOwn(cellLegProjection, state)) return cellLegProjection[state as CellLegState];
  if(Object.hasOwn(adminLegProjection, state)) return adminLegProjection[state as AdminLegState];
  return 'unknown';
}
function milliseconds(value: unknown): number | null {
  if(value === null) return null;
  if(typeof value !== 'number' && (typeof value !== 'string' || value.trim() === '')) throw new Error('INVALID_CALL_TIMESTAMP');
  const numeric = Number(value);
  if(!Number.isFinite(numeric) || numeric < 0 || numeric > 8_640_000_000_000_000) throw new Error('INVALID_CALL_TIMESTAMP');
  return Math.floor(numeric);
}
function requiredMilliseconds(value: unknown): number {
  const result = milliseconds(value);
  if(result === null) throw new Error('INVALID_CALL_TIMESTAMP');
  return result;
}
function projectLegs(value: unknown): unknown {
  if(!Array.isArray(value)) return value;
  return value.map((leg: Record<string, unknown>) => ({...leg, state:projectLegState(leg.state), connectedAt:milliseconds(leg.connectedAt), endedAt:milliseconds(leg.endedAt)}));
}
const legSelect = `COALESCE((SELECT json_agg(json_build_object('id',l.id,'type',l.type,'state',l.state,'connectedAt',extract(epoch from l.connected_at)*1000,'endedAt',extract(epoch from l.ended_at)*1000,'endCause',l.end_cause)) FROM call_leg l WHERE l.session_id=c.id),'[]'::json) AS legs`;
function projectSession(row: Record<string, unknown>) {
  return {...row,cursorTime:undefined,startedAt:requiredMilliseconds(row.startedAt),answeredAt:milliseconds(row.answeredAt),endedAt:milliseconds(row.endedAt),legs:projectLegs(row.legs)};
}
// PostgreSQL ISO text and legacy UTC cursors are passed through without rounding.
function validCallCursorTime(value:unknown):value is string {
 if(typeof value!=='string'||value.length>64||!/^\d{4}-/.test(value))return false;
 let candidate=value.endsWith('Z')?value.slice(0,-1)+'+00':value;
 // Date.UTC in the shared validator maps years 1..99 to 1901..1999.
 const year=Number(candidate.slice(0,4));
 if(year>=1&&year<=99){const leap=year%4===0&&(year%100!==0||year%400===0);candidate=(leap?'2000':'2001')+candidate.slice(4);}
 return validPgTimestamp(candidate);
}
function decodeCallCursor(encoded:string):{time:string;id:string} {
 try {
  if(encoded.length>2048||!/^[A-Za-z0-9_-]+$/.test(encoded))throw new Error();
  const bytes=Buffer.from(encoded,'base64url');if(bytes.toString('base64url')!==encoded)throw new Error();
  const value:unknown=JSON.parse(bytes.toString('utf8'));
  if(!value||typeof value!=='object'||Array.isArray(value))throw new Error();
  const v=value as Record<string,unknown>;
  if(!validCallCursorTime(v.time)||typeof v.id!=='string'||v.id.length>100||v.id.includes('\0'))throw new Error();
  return {time:v.time,id:v.id};
 }catch{throw new Error('BAD_CURSOR');}
}
// Never return a pagination token that this repository cannot consume.
function encodeCallCursor(time:unknown,id:unknown):string {
 const encoded=Buffer.from(JSON.stringify({time,id})).toString('base64url');
 try {decodeCallCursor(encoded);}catch{throw new Error('INVALID_CALL_CURSOR');}
 return encoded;
}
export interface CallFilters {kind?:'web_out'|'platform_in'|'platform_out';deviceId?:string;active?:boolean;limit:number;cursor?:string}
export class CallReadRepository {constructor(private readonly pool:pg.Pool){}async list(f:CallFilters):Promise<{data:unknown[];nextCursor:string|null}>{const cursor=f.cursor===undefined?null:decodeCallCursor(f.cursor);const r=await this.pool.query(`SELECT c.id,(to_char(c.started_at AT TIME ZONE 'UTC','YYYY-MM-DD HH24:MI:SS.US') || '+00') AS "cursorTime",c.kind,c.state,c.device_id AS "deviceId",c.sim_id AS "simId",c.peer,c.peer_kind AS "peerKind",c.platform,extract(epoch from c.started_at)*1000 AS "startedAt",extract(epoch from c.answered_at)*1000 AS "answeredAt",extract(epoch from c.ended_at)*1000 AS "endedAt",c.end_cause AS "endCause",c.prompt_played AS "promptPlayed",c.early_media_forwarded AS "earlyMediaForwarded",${legSelect} FROM call_session c WHERE ($1::text IS NULL OR c.kind=$1) AND ($2::text IS NULL OR c.device_id=$2) AND ($3::boolean IS NULL OR (c.state<>'ended')=$3) AND ($4::timestamptz IS NULL OR (c.started_at,c.id)<($4,$5)) ORDER BY c.started_at DESC,c.id DESC LIMIT $6`,[f.kind??null,f.deviceId??null,f.active??null,cursor?cursor.time:null,cursor?.id??null,f.limit+1]);const rows=r.rows as Record<string,unknown>[];const data=rows.slice(0,f.limit).map(projectSession);const last=rows[f.limit-1];return {data,nextCursor:rows.length>f.limit&&last?encodeCallCursor(last.cursorTime,last.id):null};}
 async summaryForEvent(eventId: string): Promise<unknown | null> {
  const event = await this.pool.query<{session_id: string}>('SELECT session_id FROM call_event WHERE id=$1', [eventId]);
  const id = event.rows[0]?.session_id;
  return id ? this.summary(id) : null;
 }
 async summary(id:string):Promise<unknown|null>{
  const r=await this.pool.query(`SELECT c.id,c.kind,c.state,c.device_id AS "deviceId",c.sim_id AS "simId",c.peer,c.peer_kind AS "peerKind",c.platform,extract(epoch from c.started_at)*1000 AS "startedAt",extract(epoch from c.answered_at)*1000 AS "answeredAt",extract(epoch from c.ended_at)*1000 AS "endedAt",c.end_cause AS "endCause",c.prompt_played AS "promptPlayed",c.early_media_forwarded AS "earlyMediaForwarded",${legSelect} FROM call_session c WHERE c.id=$1`,[id]);
  return r.rows[0]?projectSession(r.rows[0] as Record<string,unknown>):null;
 }
 async eventPage(sessionId:string,limit:number,encoded?:string):Promise<{data:unknown[];nextCursor:string|null}|null>{
  if(!Number.isInteger(limit)||limit<1||limit>100)throw new Error('BAD_REQUEST');
  let cursor:{session:string;time:string;id:string}|null=null;
  if(encoded!==undefined){
   try {
    if(!/^[A-Za-z0-9_-]+$/.test(encoded)||encoded.length>8192)throw new Error();
    const decoded=Buffer.from(encoded,'base64url');if(decoded.toString('base64url')!==encoded)throw new Error();
    const parsed:unknown=JSON.parse(decoded.toString('utf8'));
    if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))throw new Error();
    const v=parsed as Record<string,unknown>;
    if(Object.keys(v).sort().join(',')!=='id,session,time,v'||v.v!==1||v.session!==sessionId||typeof v.id!=='string'||Buffer.byteLength(v.id)>512||v.id.includes('\0')||typeof v.time!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(v.time))throw new Error();
    const date=new Date(v.time);if(v.time.startsWith('0000-')||!Number.isFinite(date.getTime())||date.toISOString().slice(0,19)!==v.time.slice(0,19))throw new Error();
    cursor={session:sessionId,time:v.time,id:v.id};
   }catch{throw new Error('BAD_CURSOR');}
  }
  const result=await this.pool.query(`SELECT p.present,p.id,p.event,p."legId",p.oversized,p."cursorTime",p.ts FROM call_session c LEFT JOIN LATERAL (SELECT e.ts AS sort_ts,e.id AS sort_id,true AS present,CASE WHEN octet_length(e.id)<=512 AND octet_length(e.event)<=4096 AND (e.leg_id IS NULL OR octet_length(e.leg_id)<=512) THEN e.id END AS id,CASE WHEN octet_length(e.id)<=512 AND octet_length(e.event)<=4096 AND (e.leg_id IS NULL OR octet_length(e.leg_id)<=512) THEN e.event END AS event,CASE WHEN octet_length(e.leg_id)<=512 THEN e.leg_id END AS "legId",(octet_length(e.id)>512 OR octet_length(e.event)>4096 OR COALESCE(octet_length(e.leg_id)>512,false)) AS oversized,to_char(e.ts AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "cursorTime",extract(epoch from e.ts)*1000 AS ts FROM call_event e WHERE e.session_id=c.id AND ($2::timestamptz IS NULL OR (e.ts,e.id)>($2::timestamptz,$3::text)) ORDER BY e.ts,e.id LIMIT $4) p ON true WHERE c.id=$1 ORDER BY p.sort_ts,p.sort_id`,[sessionId,cursor?.time??null,cursor?.id??null,limit+1]);
  if(!result.rows.length)return null;
  const rows=(result.rows as Record<string,unknown>[]).filter(row=>row.present===true);const page=rows.slice(0,limit);
  if(page.some(row=>row.oversized))throw new Error('EVENT_TOO_LARGE');
  const data=page.map(row=>({id:row.id,sessionId,legId:row.legId,event:row.event,ts:requiredMilliseconds(row.ts)}));
  const last=page.at(-1);let nextCursor:string|null=null;
  if(rows.length>limit&&last){const time=last.cursorTime;if(typeof time!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(time)||typeof last.id!=='string')throw new Error('INVALID_CALL_TIMESTAMP');nextCursor=Buffer.from(JSON.stringify({v:1,session:sessionId,time,id:last.id})).toString('base64url');}
  return {data,nextCursor};
 }
 async detail(id:string):Promise<unknown|null>{
  const r=await this.pool.query(`SELECT c.id,c.kind,c.state,c.device_id AS "deviceId",c.sim_id AS "simId",c.peer,c.peer_kind AS "peerKind",c.platform,extract(epoch from c.started_at)*1000 AS "startedAt",extract(epoch from c.answered_at)*1000 AS "answeredAt",extract(epoch from c.ended_at)*1000 AS "endedAt",c.end_cause AS "endCause",c.prompt_played AS "promptPlayed",c.early_media_forwarded AS "earlyMediaForwarded",${legSelect},COALESCE((SELECT json_agg(json_build_object('id',e.id,'sessionId',e.session_id,'legId',e.leg_id,'event',e.event,'payload',e.payload,'ts',extract(epoch from e.ts)*1000) ORDER BY e.ts,e.id) FROM call_event e WHERE e.session_id=c.id),'[]'::json) AS events FROM call_session c WHERE c.id=$1`,[id]);
  const row=r.rows[0] as Record<string,unknown>|undefined;
  if(!row)return null;
  const events=(row.events as Record<string,unknown>[]).map(event=>({...event,ts:requiredMilliseconds(event.ts)}));
  return {...projectSession(row),events};
 }
}
