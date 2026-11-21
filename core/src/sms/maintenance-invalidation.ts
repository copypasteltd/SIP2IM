import type pg from 'pg';
import {transaction} from '../db/pool.js';

/** Durable server-side broadcast attempts, not browser acknowledgements.
 * Single-Core fanout; a crash after publish may cause a duplicate. A snapshot
 * may be superseded, so clients invalidate and refetch rather than apply it.
 */
export class SmsMaintenanceInvalidation {
  private running: Promise<void> | undefined;
  private stopped = false;
  private dirty = false;
  constructor(private readonly pool: pg.Pool, private readonly publish: (type: string, data: unknown) => Promise<void>) {}

  flush(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    this.dirty = true;
    // Register before any port runs and clear ownership in run() itself.
    // An outer .finally() leaves a microtask gap that can swallow a new wake.
    return this.running ??= Promise.resolve().then(() => this.run());
  }

  async stop(): Promise<void> {
    this.stopped = true;
    await this.running?.catch(() => {});
  }

  private async run(): Promise<void> {
    let failure: unknown;
    let failed = false;
    try {
      while (!this.stopped) {
        this.dirty = false;
        try { await this.batch(); }
        catch (error) { if (!failed) failure = error; failed = true; }
        if (!this.dirty || this.stopped) break;
        await new Promise<void>(resolve => setImmediate(resolve));
      }
      if (failed) throw failure;
    } finally {
      this.running = undefined;
    }
  }

  private async batch(): Promise<void> {
    for (let i = 0; i < 100 && !this.stopped; i++) {
      const row = await transaction(this.pool, async client => {
        await client.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED');
        const pending = await client.query<{ taskId: string; version: string }>(
          'SELECT o.task_id AS "taskId", o.created_at::text AS version FROM sms_maintenance_admin_invalidation o ORDER BY o.created_at,o.task_id FOR UPDATE OF o SKIP LOCKED LIMIT 1',
        );
        const marker = pending.rows[0];
        if (!marker || this.stopped) return;
        // Read after locking the marker so any committed predecessor is visible.
        const snapshot = await client.query<{ smsMessageId: string; task: unknown }>(
          `SELECT m.id AS "smsMessageId", json_build_object('id',t.id,'state',t.state,
            'errorCode',t.error_code,'origin',t.origin,'updatedAt',floor(extract(epoch from t.updated_at)*1000)) AS task
            FROM sms_task t JOIN sms_message m ON m.id=t.sms_message_id WHERE t.id=$1`, [marker.taskId],
        );
        const projection = snapshot.rows[0];
        if (!projection) throw new Error('SMS invalidation refers to a missing task');
        return { marker, projection };
      });
      if (!row || this.stopped) return;
      // Fanout authenticates via the same pool. Release the read transaction and
      // the marker lock before fanout to avoid holding a connection for it.
      await this.publish('sms.task.updated', row.projection);
      // An update during fanout must leave a marker for the newer snapshot.
      // Keep full timestamp precision rather than converting through JS Date.
      await transaction(this.pool, async client => {
        await client.query('DELETE FROM sms_maintenance_admin_invalidation WHERE task_id=$1 AND created_at=$2::timestamptz', [row.marker.taskId, row.marker.version]);
      });
    }
  }
}
