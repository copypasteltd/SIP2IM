import type pg from 'pg';

/** Call with the task lock held, in the transaction that changes its projection. */
export async function enqueueSmsTaskInvalidation(client: pg.PoolClient, id: string): Promise<void> {
  // A conflict must advance the marker: the worker may already have its prior snapshot.
  // Use an exact database timestamp; do not round or trust the wall clock to be monotonic.
  await client.query(
    `INSERT INTO sms_maintenance_admin_invalidation(task_id) VALUES ($1)
      ON CONFLICT (task_id) DO UPDATE SET created_at=GREATEST(clock_timestamp(),
        sms_maintenance_admin_invalidation.created_at+interval '1 microsecond')`, [id]);
}
