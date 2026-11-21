import type pg from 'pg';
import {transaction} from '../db/pool.js';

/** Call inside the same transaction as the incoming sms_message insert. */
export async function enqueueIncomingSms(client: pg.PoolClient, eventId: string): Promise<void> {
  const result = await client.query('INSERT INTO sms_incoming_admin_outbox(event_id) VALUES ($1) ON CONFLICT (event_id) DO NOTHING', [eventId]);
  if (result.rowCount === 1) return;
  if (result.rowCount === 0) {
    const pending = await client.query('SELECT event_id FROM sms_incoming_admin_outbox WHERE event_id=$1 FOR KEY SHARE', [eventId]);
    if (pending.rowCount === 1) return;
  }
  throw new Error('INCOMING_SMS_NOTIFICATION_NOT_WRITTEN');
}

/** Serializes local flushes; row locks serialize workers in separate processes.
 * Completion records only a server-side broadcast attempt, including when no clients are
 * connected. The hub swallows individual socket failures; browsers do not acknowledge.
 * Clients must refresh from REST on reconnect and deduplicate by SMS id. A crash after
 * publication and before commit may cause a repeat on recovery. With multiple server
 * instances sharing this outbox only the worker that claims a row broadcasts it to its
 * own hub; a single server instance is required for fanout to all connected admins.
 * The row lock and pool connection are held during authentication and fanout; pool
 * contention or a stalled publish delays the attempt and other database work. A wake during
 * a failed attempt triggers one yielded recheck; the original failure is still reported.
 * Shutdown waits for in-flight database and publish operations; it cannot cancel a stalled one.
 */
export class IncomingSmsOutbox {
  private running: Promise<void> | undefined;
  private stopped = false;
  private dirty = false;
  constructor(private readonly pool: pg.Pool, private readonly publish: (type: string, data: unknown) => Promise<void>) {}

  flush(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    this.dirty = true;
    if (this.running) return this.running;
    this.running = this.run();
    return this.running;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    // Flush callers observe failures; shutdown only waits for the attempt to settle.
    await this.running?.catch(() => {});
  }

  private async run(): Promise<void> {
    let failure: unknown;
    let failed = false;
    try {
      while (!this.stopped) {
        this.dirty = false;
        let full = false;
        try {
          full = await this.drainBatch();
        } catch (error) {
          if (!failed) failure = error;
          failed = true;
          // Only a wake received during this attempt permits another attempt.
          if (!this.dirty || this.stopped) break;
        }
        if (this.stopped || (!full && !this.dirty)) break;
        // Yield between batches and dirty rechecks; never retry failures in a tight loop.
        await new Promise<void>(resolve => setImmediate(resolve));
      }
      if (failed) throw failure;
    } finally {
      this.running = undefined;
    }
  }

  private async drainBatch(): Promise<boolean> {
    for (let i = 0; i < 100 && !this.stopped; i++) {
      const found = await transaction(this.pool, async client => {
        const result = await client.query<{
          eventId:string; id:string; deviceId:string; simId:string|null; direction:string;
          peer:string; peerKind:string; body:string; parts:number; occurredAt:string|number;
        }>(`SELECT o.event_id AS "eventId",m.id,m.device_id AS "deviceId",m.sim_id AS "simId",m.direction,m.peer,m.peer_kind AS "peerKind",m.body,m.parts,floor(extract(epoch from m.occurred_at)*1000) AS "occurredAt"
          FROM sms_incoming_admin_outbox o JOIN sms_message m ON m.event_id=o.event_id
          ORDER BY o.created_at,o.event_id FOR UPDATE OF o SKIP LOCKED LIMIT 1`);
        const row = result.rows[0];
        // stop() may have arrived while connecting or waiting for the row lock.
        if (!row || this.stopped) return false;
        const {eventId, ...sms} = row;
        await this.publish('sms.new', {...sms, occurredAt: Number(sms.occurredAt), task: null});
        await client.query('DELETE FROM sms_incoming_admin_outbox WHERE event_id=$1', [eventId]);
        return true;
      });
      if (!found) return false;
    }
    return !this.stopped;
  }
}
