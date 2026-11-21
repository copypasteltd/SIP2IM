import { ulid } from 'ulid';
import type pg from 'pg';
import { transaction } from '../db/pool.js';
import { validPgTimestamp } from '../util/cursor.js';

export type AlertState = 'open' | 'acked' | 'resolved';
type Cursor = { v: 1; state: AlertState | null; time: string; id: string };
type AlertRow = { id: string; cursorTime?: string } & Record<string, unknown>;
type Page = { data: AlertRow[]; nextCursor: string | null };

const projection = `id,type,subject_type AS "subjectType",subject_id AS "subjectId",severity,state,detail,
  floor(extract(epoch from first_at)*1000)::double precision AS "firstAt",
  floor(extract(epoch from last_at)*1000)::double precision AS "lastAt",
  floor(extract(epoch from pushed_at)*1000)::double precision AS "pushedAt",
  floor(extract(epoch from resolved_at)*1000)::double precision AS "resolvedAt"`;

export const alertCursorMax = 1024;
export class BadAlertCursor extends Error {}

// Keep exact legacy text identifiers as well as alr_ IDs; they are never SQL.
export function validAlertId(id: unknown): id is string {
  if (typeof id !== 'string' || id.length === 0 || Buffer.byteLength(id) > 256) return false;
  return !Array.from(id).some(char => {
    const code = char.codePointAt(0)!;
    return code < 32 || code === 127 || (code >= 0xd800 && code <= 0xdfff);
  });
}

function isCursorTime(time: unknown): time is string {
  return validPgTimestamp(time) && time.length === 29 && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{6}\+00$/.test(time);
}
const encode = (cursor: Cursor): string => Buffer.from(JSON.stringify(cursor)).toString('base64url');

function readCursor(encoded: string, state: AlertState | null): Cursor {
  try {
    if (encoded.length > alertCursorMax || !/^[A-Za-z0-9_-]+$/.test(encoded)) throw new Error();
    const value: unknown = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    const row = value as Record<string, unknown>;
    if (row.v !== 1 || row.state !== state || !isCursorTime(row.time) || !validAlertId(row.id)) throw new Error();
    const cursor: Cursor = { v: 1, state, time: row.time, id: row.id };
    if (encoded !== encode(cursor)) throw new Error();
    return cursor;
  } catch { throw new BadAlertCursor('Invalid alert cursor'); }
}

export async function listAlerts(pool: pg.Pool, state: AlertState | null,
  options: { limit?: number; cursor?: string }): Promise<Page> {
  if (options.limit === undefined && options.cursor === undefined) {
    const result = await pool.query<AlertRow>(`SELECT ${projection} FROM alert
      WHERE ($1::text IS NULL OR state=$1) ORDER BY first_at DESC,id DESC`, [state]);
    return { data: result.rows, nextCursor: null };
  }
  const limit = options.limit ?? 50;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('Invalid alert page size');
  const cursor = options.cursor === undefined ? null : readCursor(options.cursor, state);
  const result = await pool.query<AlertRow>(`SELECT ${projection},
      to_char(first_at AT TIME ZONE 'UTC','YYYY-MM-DD HH24:MI:SS.US') || '+00' AS "cursorTime"
    FROM alert WHERE ($1::text IS NULL OR state=$1)
      AND ($2::timestamptz IS NULL OR (first_at,id)<($2::timestamptz,$3::text))
    ORDER BY first_at DESC,id DESC LIMIT $4`, [state, cursor?.time ?? null, cursor?.id ?? null, limit + 1]);
  const rows = result.rows.slice(0, limit);
  const last = rows.at(-1);
  let nextCursor: string | null = null;
  if (last && result.rows.length > limit) {
    if (!isCursorTime(last.cursorTime) || !validAlertId(last.id)) throw new Error('Cannot encode alert cursor');
    nextCursor = encode({ v: 1, state, time: last.cursorTime, id: last.id });
    if (nextCursor.length > alertCursorMax) throw new Error('Alert cursor exceeds limit');
  }
  return { data: rows.map(({ cursorTime: _, ...row }) => row), nextCursor };
}

type AckResult = { status: 'unauthorized' | 'missing' } | { status: 'acknowledged'; data: AlertRow };

/** The state transition and its audit row either commit together or not at all. */
export async function acknowledgeAlert(pool: pg.Pool, id: string, session: {
  actor: string; tokenHash: Buffer; ip: string;
}, assertAdmission: () => void = () => {}): Promise<AckResult> {
  assertAdmission();
  return transaction<AckResult>(pool, async client => {
    // Recheck the exact session and serialize against session removal before a write.
    const authority = await client.query(`SELECT 1 FROM admin_session
      WHERE token_hash=$1 AND admin_id=$2 AND expires_at>clock_timestamp() FOR SHARE`, [session.tokenHash, session.actor]);
    if (authority.rowCount === 0) return { status: 'unauthorized' };
    if (authority.rowCount !== 1) throw new Error('Cannot verify alert acknowledgement authority');
    assertAdmission();
    const changed = await client.query<AlertRow>(`UPDATE alert SET state='acked'
      WHERE id=$1 AND state='open' RETURNING ${projection}`, [id]);
    if (changed.rowCount === 0) return { status: 'missing' };
    const row = changed.rows[0];
    if (changed.rowCount !== 1 || row?.id !== id) throw new Error('Invalid alert acknowledgement result');
    assertAdmission();
    const audit = await client.query(`INSERT INTO audit_log(id,action,target_type,target_id,detail,ip)
      VALUES($1,'alert.ack','alert',$2,jsonb_build_object('actor',$3::text),$4)`,
      ['aud_' + ulid(), id, session.actor, session.ip]);
    if (audit.rowCount !== 1) throw new Error('Alert acknowledgement audit was not recorded');
    assertAdmission();
    return { status: 'acknowledged', data: row };
  });
}
