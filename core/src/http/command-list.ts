import type {FastifyInstance} from 'fastify';
import type pg from 'pg';
import {z} from 'zod';
import {validPgTimestamp} from '../util/cursor.js';

const querySchema = z.object({
  platform: z.enum(['qq', 'telegram']).optional(),
  kind: z.enum(['call', 'sms']).optional(),
  limit: z.string().regex(/^[0-9]+$/).transform(Number).pipe(z.number().int().min(1).max(200)).prefault('50'),
  cursor: z.string().min(1).max(512).optional(),
}).strict();
const failure = (code:string) => ({error:{code,message:code,details:null}});

type Cursor = {time:string; id:string};
function decodeCursor(encoded:string):Cursor {
  try {
    if (!/^[A-Za-z0-9_-]+$/.test(encoded) || Buffer.from(encoded,'base64url').toString('base64url') !== encoded) throw new Error();
    const value:unknown = JSON.parse(Buffer.from(encoded,'base64url').toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    const c = value as Record<string,unknown>;
    if (Object.keys(c).length !== 2 || !validPgTimestamp(c.time) || typeof c.id !== 'string' || !/^req_[0-7][0-9A-HJKMNP-TV-Z]{25}$/.test(c.id)) throw new Error();
    return {time:c.time,id:c.id};
  } catch { throw new Error('BAD_CURSOR'); }
}

export async function listCommands(pool:pg.Pool, filters:{platform?:'qq'|'telegram';kind?:'call'|'sms';limit:number;cursor?:string}) {
  const cursor = filters.cursor === undefined ? undefined : decodeCursor(filters.cursor);
  // One snapshot and no row locks: readers do not participate in writer lock ordering.
  const result = await pool.query(`SELECT id,kind,platform,paired_user_id AS "pairedUserId",raw_text AS "rawText",
    from_number AS "fromNumber",from_sim_id AS "fromSimId",to_number AS "toNumber",to_kind AS "toKind",
    body,state,reject_code AS "rejectCode",session_id AS "sessionId",sms_task_id AS "smsTaskId",
    to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD HH24:MI:SS.US') || '+00' AS "cursorTime",floor(extract(epoch from created_at)*1000)::double precision AS "createdAt"
    FROM outbound_request
    WHERE ($1::text IS NULL OR platform=$1) AND ($2::text IS NULL OR kind=$2)
      AND ($3::timestamptz IS NULL OR (created_at,id)<($3::timestamptz,$4::text))
    ORDER BY created_at DESC,id DESC LIMIT $5`,
    [filters.platform ?? null,filters.kind ?? null,cursor?.time ?? null,cursor?.id ?? null,filters.limit+1]);
  const rows = result.rows as Record<string,unknown>[];
  const data = rows.slice(0,filters.limit).map(({cursorTime: _cursorTime,...row}) => row);
  const last = rows[filters.limit-1];
  const nextCursor = rows.length > filters.limit && last
    ? Buffer.from(JSON.stringify({time:last.cursorTime,id:last.id})).toString('base64url') : null;
  // Replies are not stored or associated with commands by the current schema.
  return {data,nextCursor};
}

export function registerCommandList(app:FastifyInstance,pool:pg.Pool,authenticate:(token:string)=>Promise<string|null>):void {
  app.get('/api/commands',async(req,reply)=>{
    const match = /^Bearer (.+)$/.exec(req.headers.authorization ?? '');
    if (!match || !await authenticate(match[1]!)) return reply.code(401).send(failure('UNAUTHORIZED'));
    const parsed = querySchema.safeParse(req.query);
    if (!parsed.success) return reply.code(400).send(failure('BAD_REQUEST'));
    try { return await listCommands(pool,parsed.data); }
    catch (error) { if (error instanceof Error && error.message === 'BAD_CURSOR') return reply.code(400).send(failure('BAD_REQUEST')); throw error; }
  });
}
