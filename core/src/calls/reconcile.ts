import type pg from 'pg';
import { transaction } from '../db/pool.js';
import { setCallState } from './device-events.js';
import type { CallState } from './coordinator.js';

/** Run before accepting device connections or starting the intent worker.
 * A restart loses knowledge of external actions; never replay them as if safe.
 */
export async function reconcileCalls(pool: pg.Pool, assertOwnership: () => void = () => {}): Promise<number> {
  return transaction(pool, async client => {
    const sessions = await client.query<{id: string; state: CallState; unarmed: boolean}>(
      `SELECT id,state,kind='web_out' AND state='awaiting_browser'
        AND NOT EXISTS (SELECT 1 FROM call_outbound_attempt a WHERE a.session_id=s.id)
        AND EXISTS (SELECT 1 FROM call_leg l WHERE l.session_id=s.id AND l.type='cellular' AND l.state='created') AS unarmed
        FROM call_session s WHERE state NOT IN ('ended','unknown')
          OR EXISTS (SELECT 1 FROM call_reject_intent i WHERE i.session_id=s.id AND i.state IN ('pending','sending','accepted'))
          OR EXISTS (SELECT 1 FROM call_outbound_attempt a WHERE a.session_id=s.id AND (a.ack_state='pending' OR a.callback_intent='quarantined'))
        ORDER BY id FOR UPDATE OF s`,
    );
    let changed = 0;
    for (const session of sessions.rows) {
      assertOwnership();
      // Lock session before intent, consistently with the event handler and worker.
      await client.query("UPDATE call_reject_intent SET state='unknown',lease_until=NULL,updated_at=now() WHERE session_id=$1 AND state IN ('pending','sending','accepted')", [session.id]);
      await client.query("UPDATE call_outbound_attempt SET ack_state=CASE WHEN ack_state='pending' THEN 'unknown' ELSE ack_state END,callback_intent=CASE WHEN callback_intent='quarantined' THEN 'unknown' ELSE callback_intent END,updated_at=now() WHERE session_id=$1", [session.id]);
      if (session.unarmed) {
        await client.query("UPDATE call_leg SET state='ended',ended_at=clock_timestamp(),updated_at=clock_timestamp() WHERE session_id=$1 AND state='created'", [session.id]);
        if (await setCallState(client, session.id, session.state, 'ended', 'core_restart_before_dial', null)) changed++;
      } else if (session.state !== 'unknown' && session.state !== 'ended' && await setCallState(client, session.id, session.state, 'unknown', 'core_restart', 'unknown')) changed++;
    }
    assertOwnership();
    return changed;
  });
}
