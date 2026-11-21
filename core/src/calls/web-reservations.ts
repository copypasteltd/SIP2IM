import type pg from 'pg';
import { transaction } from '../db/pool.js';
import { setCallState } from './device-events.js';
import { identityEvent } from './generation.js';

export const WEB_RESERVATION_SWEEP_PAGE = 16;
export const expiredWebReservation = "s.started_at <= clock_timestamp() - interval '30 seconds'";

/** Uses alias s. State alone cannot prove that an external action never ran. */
export const unarmedWebReservation = `s.kind='web_out' AND s.state='awaiting_browser'
  AND s.answered_at IS NULL AND s.ended_at IS NULL AND s.end_cause IS NULL
  AND NOT s.prompt_played AND NOT s.early_media_forwarded
  AND NOT EXISTS (SELECT 1 FROM call_reject_intent r WHERE r.session_id=s.id)
  AND NOT EXISTS (SELECT 1 FROM call_outbound_attempt a WHERE a.session_id=s.id)
  AND (SELECT count(*)=2
    AND count(*) FILTER (WHERE l.type='browser' AND l.state='created' AND l.connected_at IS NULL
      AND l.ended_at IS NULL AND l.end_cause IS NULL)=1
    AND count(*) FILTER (WHERE l.type='cellular' AND l.state='created' AND l.connected_at IS NULL
      AND l.ended_at IS NULL AND l.end_cause IS NULL)=1
    FROM call_leg l WHERE l.session_id=s.id)
  AND (SELECT count(*)=2
    AND count(*) FILTER (WHERE e.event='state:awaiting_browser' AND e.leg_id IS NULL
      AND e.payload->>'reason'='awaiting_browser_media')=1
    AND count(*) FILTER (WHERE e.event='${identityEvent}'
      AND jsonb_typeof(e.payload->'generation')='string' AND e.payload->>'generation'<>''
      AND jsonb_typeof(e.payload->'connectionId')='string' AND e.payload->>'connectionId'<>''
      AND EXISTS (SELECT 1 FROM call_leg cell WHERE cell.id=e.leg_id AND cell.session_id=e.session_id
        AND cell.type='cellular' AND cell.ref_id=(e.payload->>'callId')))=1
    FROM call_event e WHERE e.session_id=s.id)`;

/** Caller owns a READ COMMITTED transaction. Online callers lock device before
 * session. Re-read leg and attempt evidence in a separate statement after any
 * lock wait; a stale candidate row is not authority to write. */
export async function endUnarmedWebReservation(client: pg.PoolClient, sessionId: string, reason: string,
  assertAdmission: () => void = () => {}, expiredOnly = false): Promise<boolean> {
  assertAdmission();
  const locked = await client.query('SELECT id FROM call_session WHERE id=$1 FOR UPDATE', [sessionId]);
  assertAdmission();
  if (locked.rowCount === 0) return false;
  if (locked.rowCount !== 1) throw new Error('Cannot lock web call reservation');
  const proof = await client.query(`SELECT 1 FROM call_session s WHERE s.id=$1
    AND ${unarmedWebReservation} AND (NOT $2::boolean OR ${expiredWebReservation})`, [sessionId, expiredOnly]);
  assertAdmission();
  if (proof.rowCount === 0) return false;
  if (proof.rowCount !== 1) throw new Error('Cannot establish unarmed web call reservation');
  const legs = await client.query(`UPDATE call_leg SET state='ended',ended_at=clock_timestamp(),updated_at=clock_timestamp()
    WHERE session_id=$1 AND type IN ('browser','cellular') AND state='created'
      AND connected_at IS NULL AND ended_at IS NULL AND end_cause IS NULL`, [sessionId]);
  if (legs.rowCount !== 2) throw new Error('Web reservation legs changed during cleanup');
  assertAdmission();
  if (!await setCallState(client, sessionId, 'awaiting_browser', 'ended', reason, null)) {
    throw new Error('Web reservation changed during cleanup');
  }
  assertAdmission();
  return true;
}

/** Periodic DB-only sweep. No media, attachment, or command port exists here. */
export class WebReservationMaintenance {
  private after: string | null = null;

  constructor(private readonly pool: pg.Pool) {}

  async sweep(assertAdmission: () => void, publish: (sessionId: string) => Promise<void>, stopping?: AbortSignal): Promise<void> {
    const stopped = new Error('Web reservation sweep is stopping');
    const admit = () => {
      if (stopping?.aborted) throw stopped;
      assertAdmission();
    };
    if (stopping?.aborted) return;
    admit();
    const cursor = this.after;
    const { rows } = await this.pool.query<{id:string;device_id:string}>(`SELECT s.id,s.device_id FROM call_session s
      WHERE ($1::text IS NULL OR s.id>$1::text) AND s.kind='web_out' AND s.state='awaiting_browser'
        AND ${expiredWebReservation}
      ORDER BY s.id LIMIT $2`, [cursor, WEB_RESERVATION_SWEEP_PAGE]);
    const failures: unknown[] = [];
    for (const { id, device_id } of rows) {
      try {
        admit();
        const changed = await transaction(this.pool, async client => {
          admit();
          await client.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED');
          await client.query('SET LOCAL synchronous_commit = on');
          admit();
          const device = await client.query('SELECT id FROM device WHERE id=$1 FOR UPDATE SKIP LOCKED', [device_id]);
          admit();
          if (device.rowCount !== 1) return false;
          const session = await client.query('SELECT id FROM call_session WHERE id=$1 AND device_id=$2 FOR UPDATE SKIP LOCKED', [id, device_id]);
          admit();
          if (session.rowCount !== 1) return false;
          return endUnarmedWebReservation(client, id, 'browser_reservation_expired', admit, true);
        });
        if (changed) {
          admit();
          await publish(id);
        }
      } catch (error) {
        if (error === stopped) break;
        failures.push(error);
      }
    }
    // Skipped or failed candidates are revisited after the next wrap instead
    // of blocking later IDs. A missed notification does not roll back cleanup.
    if (!stopping?.aborted) this.after = rows.length === WEB_RESERVATION_SWEEP_PAGE ? rows.at(-1)!.id : null;
    if (failures.length) throw new AggregateError(failures, 'Web reservation maintenance failed');
  }
}
