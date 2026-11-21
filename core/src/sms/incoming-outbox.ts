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

type IncomingNotice = {
  eventId: string; markerVersion: string; id: string; deviceId: string; simId: string | null;
  direction: string; peer: string; peerKind: string; body: string; parts: number; occurredAt: string | number;
};

type IncomingOutboxOptions = {
  /** Freeze new attempts as soon as Core starts stopping. */
  stopping?: AbortSignal;
  /** Check database ownership, not shutdown admission for an already-started attempt. */
  assertOwnership?: () => void;
};

/** One worker per database under Core's exclusive ownership. Read a committed
 * snapshot, release the client before admin authentication/fanout, and then
 * delete only the matching marker. This records a broadcast attempt (including
 * no connected clients), not client delivery. Cleanup failures can repeat the
 * same hint on a later read; clients refresh from REST. */
export class IncomingSmsOutbox {
  private running: Promise<void> | undefined;
  private stopped = false;
  private dirty = false;
  constructor(private readonly pool: pg.Pool,
    private readonly publish: (type: string, data: unknown, isCurrent: () => boolean) => Promise<void>,
    private readonly options: IncomingOutboxOptions = {}) {}

  private get closing(): boolean { return this.stopped || this.options.stopping?.aborted === true; }
  private assertOwnership(): void { this.options.assertOwnership?.(); }

  flush(): Promise<void> {
    if (this.closing) return Promise.resolve();
    this.dirty = true;
    // Register before a pool or publish port can reenter flush() or stop().
    return this.running ??= Promise.resolve().then(() => this.run());
  }

  async stop(): Promise<void> {
    this.stopped = true;
    // Flush callers observe failures. Stop waits for the read or already
    // admitted broadcast and its exact cleanup; it never cancels in-flight I/O.
    await this.running?.catch(() => {});
  }

  private async run(): Promise<void> {
    let failure: unknown;
    let failed = false;
    try {
      while (!this.closing) {
        this.dirty = false;
        let full = false;
        try { full = await this.drainBatch(); }
        catch (error) {
          if (!failed) failure = error;
          failed = true;
          if (!this.dirty || this.closing) break;
        }
        if (this.closing || (!full && !this.dirty)) break;
        // Yield between batches and dirty rechecks; never retry failures in a tight loop.
        await new Promise<void>(resolve => setImmediate(resolve));
      }
      if (failed) throw failure;
    } finally {
      this.running = undefined;
    }
  }

  private async drainBatch(): Promise<boolean> {
    for (let i = 0; i < 100 && !this.closing; i++) {
      this.assertOwnership();
      // Use a single committed statement without a row lock. pool.query releases
      // its checkout before fanout, which authenticates through the same pool.
      const result = await this.pool.query<IncomingNotice>(`SELECT o.event_id AS "eventId",
        to_char(o.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US') || 'Z' AS "markerVersion",
        m.id,m.device_id AS "deviceId",m.sim_id AS "simId",m.direction,m.peer,m.peer_kind AS "peerKind",m.body,m.parts,
        floor(extract(epoch from m.occurred_at)*1000) AS "occurredAt"
        FROM sms_incoming_admin_outbox o JOIN sms_message m ON m.event_id=o.event_id
        ORDER BY o.created_at,o.event_id LIMIT 1`);
      const row = result.rows[0];
      if (!row || this.closing) return false;
      this.assertOwnership();
      if (this.closing) return false;
      const { eventId, markerVersion, ...sms } = row;
      if (!markerVersion) throw new Error('INCOMING_SMS_NOTIFICATION_MARKER_MISSING');
      // An admitted attempt may drain on normal stop. A real ownership loss
      // fences subscriber sends and must never be mistaken for a completed attempt.
      let lost: { reason: unknown } | undefined;
      const isCurrent = () => {
        if (lost) return false;
        try { this.assertOwnership(); return true; }
        catch (reason) { lost = { reason }; return false; }
      };
      await this.publish('sms.new', { ...sms, occurredAt: Number(sms.occurredAt), task: null }, isCurrent);
      if (lost) throw lost.reason;
      this.assertOwnership();
      const removed = await transaction(this.pool, async client => {
        this.assertOwnership();
        await client.query('SET LOCAL synchronous_commit = on');
        this.assertOwnership();
        const deleted = await client.query(
          'DELETE FROM sms_incoming_admin_outbox WHERE event_id=$1 AND created_at=$2::timestamptz',
          [eventId, markerVersion],
        );
        if (deleted.rowCount !== 0 && deleted.rowCount !== 1) throw new Error('INCOMING_SMS_NOTIFICATION_CLEANUP_NOT_CONFIRMED');
        return deleted.rowCount === 1;
      }, () => this.assertOwnership());
      // A zero match leaves a changed marker alone. Rediscover on a later wake
      // instead of repeatedly broadcasting a row that could not be consumed.
      if (!removed) return false;
    }
    return !this.closing;
  }
}
