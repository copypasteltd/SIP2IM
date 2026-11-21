import type pg from 'pg';
import { raiseAlert, type AlertEvent } from '../alerts/episodes.js';
import { transaction } from '../db/pool.js';

const PAGE_SIZE = 64;
const PAGES_PER_SWEEP = 4;
type CallOutcome = { state: string; end_cause: string | null };

/** For call writers, unknown is a durable outcome, even without ended_at.
 * The canonical state machine instead stores technical failures as ended with
 * a cause, so also accept its explicit network error (not normal call endings).
 */
async function qualifies(client: pg.PoolClient, id: string, row: CallOutcome): Promise<boolean> {
  if (row.state === 'unknown' || row.state === 'failed') return true;
  if (row.state !== 'ended') return false;
  if (row.end_cause === 'network_error') return true;
  if (row.end_cause !== 'unknown') return false;

  // Incoming calls can start with a placeholder unknown cause. A null-cause
  // disconnect leaves it unchanged. Require the cellular leg's actual projected
  // end cause, not merely a raw or late event reporting unknown. The event join
  // locates that leg via call_event(session_id, ts) and the leg primary key.
  const evidence = await client.query(
    `SELECT 1 FROM call_event e JOIN call_leg l ON l.id=e.leg_id AND l.session_id=e.session_id
      WHERE e.session_id=$1 AND e.event='device:call.state'
        AND l.type='cellular' AND l.state='disconnected' AND l.end_cause='unknown' LIMIT 1`, [id],
  );
  return evidence.rows.length > 0;
}

/** Poll committed state from all writers (including direct inserts and restart
 * recovery). Run as an independent, non-overlapping maintenance job. It owns
 * no timer and never runs in a call's command or device-event ACK transaction.
 */
export class CallFailureAlerts {
  private cursor: string | null = null;

  constructor(private readonly pool: pg.Pool) {}

  async sweep(assertAdmission: () => void,
    publish: (type: AlertEvent['type'], data: unknown) => Promise<void>): Promise<void> {
    const failures: unknown[] = [];
    for (let i = 0; i < PAGES_PER_SWEEP; i++) {
      assertAdmission();
      const cursor = this.cursor;
      // Page through the existing primary key *before* filtering. Even a long
      // run of normal/alerted calls is bounded; it cannot end a pass early.
      // Walk newest IDs first, then wrap to revisit missed or changed rows.
      const { rows } = await this.pool.query<{ id: string; candidate: boolean }>(
        `WITH page AS MATERIALIZED (
          SELECT id,state,end_cause FROM call_session ${cursor === null ? '' : 'WHERE id<$2'}
          ORDER BY id DESC LIMIT $1
        ), candidates AS (
          SELECT p.id FROM page p
          WHERE (p.state IN ('unknown','failed') OR (p.state='ended' AND p.end_cause IN ('network_error','unknown')))
          AND NOT EXISTS (SELECT 1 FROM alert a
            WHERE a.type='call_failed' AND a.subject_type='call_session' AND a.subject_id=p.id)
        )
        SELECT p.id,c.id IS NOT NULL AS candidate FROM page p
        LEFT JOIN candidates c ON c.id=p.id ORDER BY p.id DESC`,
        cursor === null ? [PAGE_SIZE] : [PAGE_SIZE, cursor],
      );
      assertAdmission();
      for (const { id, candidate } of rows) {
        if (!candidate) continue;
        assertAdmission();
        try {
          const event = await transaction(this.pool, async client => {
            await client.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED');
            // Yield to active call writers, and bound projector statements while
            // holding the row needed by call progress and device-event ACKs.
            await client.query("SET LOCAL statement_timeout='500ms'");
            const row = (await client.query<CallOutcome>(
              'SELECT state,end_cause FROM call_session WHERE id=$1 FOR NO KEY UPDATE SKIP LOCKED', [id],
            )).rows[0];
            if (!row || !await qualifies(client, id, row)) return null;
            assertAdmission();
            const raised = await raiseAlert(client, { type: 'call_failed', subjectType: 'call_session', subjectId: id }, 'once');
            assertAdmission();
            return raised;
          });
          // A failed/unconfirmed commit produces no event. Admin reads are authoritative.
          assertAdmission();
          if (event) await publish(event.type, event.data);
        } catch (error) {
          assertAdmission();
          // A failed candidate may be retried on wrap; it must not stall later IDs.
          failures.push(error);
        }
      }
      this.cursor = rows.length === PAGE_SIZE ? rows.at(-1)!.id : null;
      if (this.cursor === null) break;
    }
    if (failures.length) throw new AggregateError(failures, 'Call failure alert projection or publication failed');
  }
}
