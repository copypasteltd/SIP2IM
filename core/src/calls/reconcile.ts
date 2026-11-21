import type pg from 'pg';
import { transaction } from '../db/pool.js';
import type { CallState } from './coordinator.js';
import { setCallState } from './device-events.js';
import { endUnarmedWebReservation, unarmedWebReservation } from './web-reservations.js';

const batchSize = 64;

/** Startup only, under exclusive Core ownership and before accepting traffic or
 * starting the intent worker. Recover durable state without replaying external actions.
 * The result counts committed session transitions, excluding evidence-only changes.
 */
export async function reconcileCalls(pool: pg.Pool, assertOwnership: () => void): Promise<number> {
  let after: string | undefined;
  let changed = 0;
  assertOwnership();
  for (;;) {
    const cursor = after;
    const batch = await transaction(pool, async client => {
      await client.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED');
      await client.query('SET LOCAL synchronous_commit = on');
      assertOwnership();
      const sessions = await client.query<{ id: string; state: CallState; unarmed: boolean }>(
        `SELECT s.id,s.state,(${unarmedWebReservation}) AS unarmed FROM call_session s
          WHERE ${cursor === undefined ? '' : 's.id>$2::text AND '}(s.state NOT IN ('ended','unknown')
            OR EXISTS (SELECT 1 FROM call_reject_intent i WHERE i.session_id=s.id AND i.state IN ('pending','sending','accepted'))
            OR EXISTS (SELECT 1 FROM call_outbound_attempt a WHERE a.session_id=s.id AND (a.ack_state='pending' OR a.callback_intent='quarantined')))
          ORDER BY s.id LIMIT $1 FOR UPDATE OF s`,
        cursor === undefined ? [batchSize] : [batchSize, cursor],
      );
      let transitions = 0;
      for (const session of sessions.rows) {
        assertOwnership();
        // Recheck positive proof under the session lock before altering any evidence.
        const ended = session.unarmed && await endUnarmedWebReservation(client, session.id, 'core_restart_before_dial', assertOwnership);
        // Follow the same session-before-intent lock order as event handling.
        await client.query("UPDATE call_reject_intent SET state='unknown',lease_until=NULL,updated_at=now() WHERE session_id=$1 AND state IN ('pending','sending','accepted')", [session.id]);
        await client.query(`UPDATE call_outbound_attempt SET
          ack_state=CASE WHEN ack_state='pending' THEN 'unknown' ELSE ack_state END,
          callback_intent=CASE WHEN callback_intent='quarantined' THEN 'unknown' ELSE callback_intent END,
          updated_at=now() WHERE session_id=$1 AND (ack_state='pending' OR callback_intent='quarantined')`, [session.id]);
        if (ended) transitions++;
        else if (session.state !== 'unknown' && session.state !== 'ended' &&
          await setCallState(client, session.id, session.state, 'unknown', 'core_restart', 'unknown')) transitions++;
      }
      assertOwnership();
      return { transitions, next: sessions.rows.length === batchSize ? sessions.rows.at(-1)?.id : undefined };
    });
    assertOwnership();
    changed += batch.transitions;
    if (batch.next === undefined) return changed;
    after = batch.next;
  }
}
