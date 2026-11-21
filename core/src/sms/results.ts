import type pg from 'pg';
import { enqueueSmsTaskInvalidation } from './task-invalidation.js';

// The existing nullable wire errorCode carries the callback observation. The original
// code stays in device_event.payload; only Core writes the sticky task error code.
export const SMS_CALLBACK_CONFLICT = 'SMS_CALLBACK_CONFLICT';
export const SMS_RESULT_CONFLICT = 'SMS_RESULT_CONFLICT';

type ResultPayload = {
  state: 'sent' | 'failed' | 'delivered' | 'unknown';
  errorCode: string | null;
};

/** Caller holds the task lock. Invalidate once after the final projected state. */
export async function replaySmsResults(client: pg.PoolClient, id: string, projectionChanged = false): Promise<void> {
  const apply = async (sql: string, values: unknown[]): Promise<boolean> => {
    const updated = await client.query(sql, values);
    const changed = updated.rowCount === 1;
    projectionChanged ||= changed;
    return changed;
  };
  const stored = await client.query<{ payload: ResultPayload }>(
    `SELECT e.payload FROM device_event e
      JOIN sms_task t ON t.id=e.payload->>'taskId'
      JOIN sms_message m ON m.id=t.sms_message_id AND m.device_id=e.device_id AND m.direction='out'
      WHERE t.id=$1 AND e.type='sms.result' ORDER BY e.received_at,e.id`,
    [id],
  );
  const observations = stored.rows.map(({ payload }) => payload)
    .filter(result => result.errorCode !== SMS_CALLBACK_CONFLICT || result.state === 'unknown');
  const callbackConflict = observations.some(result => result.errorCode === SMS_CALLBACK_CONFLICT);
  const submitted = observations.some(result => result.state === 'sent' || result.state === 'delivered');
  const failed = observations.some(result => result.state === 'failed');
  const historyConflicts = callbackConflict || (submitted && failed);

  // An explicit callback conflict or contradictory terminal evidence dominates.
  // The locked task's terminal state is itself evidence even without the old event.
  // Preserve the existing ACK and local failure rules, including legacy provenance.
  const changedToConflict = observations.length > 0 && await apply(
    `UPDATE sms_task SET state='unknown',error_code='SMS_RESULT_CONFLICT',updated_at=now()
      WHERE id=$1 AND state IN ('accepted','unknown','failed','sent','delivered')
        AND (state<>'unknown' OR error_code IS DISTINCT FROM 'SMS_RESULT_CONFLICT')
        AND ($4::boolean OR negative_ack OR local_failure OR (legacy_failure AND $2::boolean)
          OR ($2::boolean AND (state='failed' OR $3::boolean))
          OR ($3::boolean AND state IN ('sent','delivered')))`,
    [id, submitted, failed, callbackConflict],
  );

  if (!historyConflicts && !changedToConflict) {
    for (const state of ['sent', 'failed', 'delivered', 'unknown'] as const) {
      for (const result of observations) {
        if (result.state !== state) continue;
        // An explanatory unknown may fill a missing reason, including after a
        // timeout. Only determinate evidence can resolve an ordinary unknown.
        await apply(
          `UPDATE sms_task SET state=$2,error_code=$3,updated_at=now()
            WHERE id=$1 AND error_code IS DISTINCT FROM 'SMS_RESULT_CONFLICT'
              AND ((state IN ('accepted','unknown') AND $2 IN ('sent','failed'))
                OR (state='sent' AND $2='delivered')
                OR ($2='unknown' AND (state='accepted'
                  OR (state='unknown' AND error_code IS NULL AND $3::text IS NOT NULL))))`,
          [id, state, result.errorCode === SMS_RESULT_CONFLICT ? null : result.errorCode],
        );
      }
    }
  }
  if (projectionChanged) await enqueueSmsTaskInvalidation(client, id);
}
