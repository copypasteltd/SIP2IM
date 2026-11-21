import type pg from 'pg';
import { ulid } from 'ulid';

export type AlertTarget =
  | { type: 'channel_down'; subjectType: 'channel'; subjectId: string }
  | { type: 'call_failed'; subjectType: 'call_session'; subjectId: string }
  | { type: 'protocol_mismatch' | 'shizuku_autostart_failed'; subjectType: 'device'; subjectId: string };
export type AlertEvent = { type: 'alert.raised' | 'alert.resolved'; data: unknown };

const projection = `id,type,subject_type AS "subjectType",subject_id AS "subjectId",severity,state,detail,
  floor(extract(epoch from first_at)*1000)::double precision AS "firstAt",
  floor(extract(epoch from last_at)*1000)::double precision AS "lastAt",
  floor(extract(epoch from pushed_at)*1000)::double precision AS "pushedAt",
  floor(extract(epoch from resolved_at)*1000)::double precision AS "resolvedAt"`;
const targetArgs = (target: AlertTarget) => [target.type, target.subjectType, target.subjectId];

/** Call only inside a transaction that holds the authoritative parent row lock.
 * For a recoverable incident acknowledgement stays closed until recovery. For a
 * terminal outcome acknowledgement closes it permanently. Fanout is post-commit. */
export async function raiseAlert(client: pg.PoolClient, target: AlertTarget,
  policy: 'episode' | 'once' = 'episode'): Promise<AlertEvent | null> {
  const result = await client.query(`INSERT INTO alert(id,type,subject_type,subject_id,severity,state)
    SELECT $4,$1,$2,$3,'warning','open'
    WHERE NOT EXISTS (SELECT 1 FROM alert
      WHERE type=$1 AND subject_type=$2 AND subject_id=$3
        AND ($5::boolean OR (state IN ('open','acked') AND resolved_at IS NULL)))
    ON CONFLICT (type,subject_id) WHERE state='open' DO NOTHING
    RETURNING ${projection}`, [...targetArgs(target), 'alr_' + ulid(), policy === 'once']);
  return result.rows[0] ? { type: 'alert.raised', data: result.rows[0] } : null;
}

/** Keep the acked filter and history while ending the unhealthy episode. */
export async function resolveAlert(client: pg.PoolClient, target: AlertTarget): Promise<AlertEvent | null> {
  const result = await client.query(`UPDATE alert SET state=CASE WHEN state='open' THEN 'resolved' ELSE state END,
    resolved_at=GREATEST(first_at,last_at,clock_timestamp())
    WHERE type=$1 AND subject_type=$2 AND subject_id=$3
      AND state IN ('open','acked') AND resolved_at IS NULL
    RETURNING ${projection}`, targetArgs(target));
  return result.rows[0] ? { type: 'alert.resolved', data: result.rows[0] } : null;
}
