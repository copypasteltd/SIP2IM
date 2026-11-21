import type pg from 'pg';
import { CommandNamespaceRepository } from '../db/command-namespace-repo.js';
import { transaction, TransactionRolledBack } from '../db/pool.js';
import { isSmsCommandId } from './attempt-id.js';
import type { PreparedSmsDispatch, SmsCommandAck } from './dispatch.js';
import { replaySmsResults } from './results.js';
import { enqueueSmsTaskInvalidation } from './task-invalidation.js';

type Client = pg.PoolClient;

export interface SmsAttemptClaim {
  taskId: string;
  deviceId: string;
  simId: string;
  slot: number;
  subId: number | null;
  commandId: string;
}
type AttemptIdentity = Pick<SmsAttemptClaim, 'taskId' | 'deviceId' | 'commandId'>;
type LocatedAttempt = { commandId: string };
class AttemptCollision extends Error {}

export class SmsAttemptRepository {
  constructor(private readonly pool: pg.Pool) {}

  private transact<T>(work: (client: Client) => Promise<T>): Promise<T> {
    return transaction(this.pool, async client => {
      // Recovery needs fresh statement snapshots after row-lock waits.
      await client.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED');
      await client.query('SET LOCAL synchronous_commit = on');
      return work(client);
    });
  }

  prepare(input: SmsAttemptClaim): Omit<PreparedSmsDispatch, 'send'> {
    const attempt = { ...input };
    if (!isSmsCommandId(attempt.commandId)) throw new Error('Invalid outbound SMS command ID');
    let claimStarted = false;
    let claimXid: string | undefined;
    let committed = false;
    return {
      claim: async () => {
        if (claimStarted) throw new Error('SMS claim has already been attempted');
        claimStarted = true;
        try {
          committed = await this.claim(attempt, xid => { claimXid = xid; });
          return committed;
        } catch (error) {
          if (error instanceof TransactionRolledBack) claimXid = undefined;
          throw error;
        }
      },
      acknowledge: async ack => {
        if (!committed) throw new Error('SMS ACK has no confirmed local claim');
        await this.recordAck(attempt, ack);
        await this.finish(attempt, false);
      },
      // A missing or mismatched attempt cannot authorize a state-only update.
      markUnknown: async () => {
        if (claimXid) await this.finish(attempt, true, committed ? undefined : claimXid);
      },
    };
  }

  private async claim(input: SmsAttemptClaim, staged: (xid: string) => void): Promise<boolean> {
    try {
      return await this.transact(async client => {
        // Same device → SIM → task order as the dispatch eligibility and event paths.
        const device = await client.query('SELECT id FROM device WHERE id=$1 AND online=true AND enabled=true AND paused=false AND revoked_at IS NULL FOR UPDATE', [input.deviceId]);
        if (device.rowCount !== 1) return false;
        const sim = await client.query("SELECT id FROM sim WHERE id=$1 AND device_id=$2 AND retired_at IS NULL AND state='ready' AND last_seen_at >= clock_timestamp()-interval '2 hours' AND slot=$3 AND sub_id IS NOT DISTINCT FROM $4 FOR UPDATE", [input.simId, input.deviceId, input.slot, input.subId]);
        if (sim.rowCount !== 1) return false;
        const task = await client.query("SELECT t.id FROM sms_task t JOIN sms_message m ON m.id=t.sms_message_id WHERE t.id=$1 AND m.device_id=$2 AND m.sim_id=$3 AND m.direction='out' AND t.state='queued' FOR UPDATE OF t", [input.taskId, input.deviceId, input.simId]);
        if (task.rowCount !== 1) return false;

        const legacy = await client.query(`SELECT 1 FROM call_outbound_attempt WHERE command_id=$1
          UNION ALL SELECT 1 FROM sms_dispatch_attempt WHERE command_id=$1 OR task_id=$2 LIMIT 1`, [input.commandId, input.taskId]);
        if (legacy.rowCount) return false;
        const reserved = await new CommandNamespaceRepository(client).reserve({
          commandId: input.commandId, commandType: 'sms.send', ownerType: 'sms_task', ownerId: input.taskId, deviceId: input.deviceId,
        });
        if (!reserved) return false;
        const inserted = await client.query('INSERT INTO sms_dispatch_attempt(task_id,device_id,command_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING RETURNING task_id', [input.taskId, input.deviceId, input.commandId]);
        if (inserted.rowCount !== 1) throw new AttemptCollision();
        // The statement runs after locking. Expiry can pass while waiting for locks.
        const updated = await client.query("UPDATE sms_task SET state='dispatched',error_code=NULL,updated_at=now() WHERE id=$1 AND state='queued' AND created_at>clock_timestamp()-interval '24 hours'", [input.taskId]);
        if (updated.rowCount !== 1) throw new AttemptCollision();
        await enqueueSmsTaskInvalidation(client, input.taskId);
        const tx = await client.query<{ xid: string }>('SELECT pg_current_xact_id()::text AS xid');
        const xid = tx.rows[0]?.xid;
        if (!xid) throw new Error('SMS claim transaction identity is unavailable');
        staged(xid);
        return true;
      });
    } catch (error) {
      // Only the original abort with clean rollback/release is a normal no-claim.
      if (error instanceof AttemptCollision) return false;
      throw error;
    }
  }

  private async lockTask(client: Client, input: AttemptIdentity): Promise<boolean> {
    // Lock independently of the attempt's visibility. If the claim COMMIT reply was
    // lost, the next statement gets a fresh snapshot after that transaction settles.
    const task = await client.query("SELECT t.id FROM sms_task t JOIN sms_message m ON m.id=t.sms_message_id WHERE t.id=$1 AND m.device_id=$2 AND m.direction='out' FOR UPDATE OF t", [input.taskId, input.deviceId]);
    return task.rowCount === 1;
  }

  private async locate(client: Client, taskId: string): Promise<LocatedAttempt | undefined> {
    const rows = await client.query<LocatedAttempt>(`SELECT a.command_id AS "commandId"
      FROM sms_dispatch_attempt a
      JOIN command_namespace_reservation r ON r.command_id=a.command_id AND r.command_type='sms.send'
        AND r.owner_type='sms_task' AND r.owner_id=a.task_id AND r.device_id=a.device_id
      JOIN sms_task t ON t.id=a.task_id
      JOIN sms_message m ON m.id=t.sms_message_id AND m.device_id=a.device_id AND m.direction='out'
      WHERE a.task_id=$1 AND NOT EXISTS (SELECT 1 FROM call_outbound_attempt c WHERE c.command_id=a.command_id)`, [taskId]);
    const attempt = rows.rows[0];
    return attempt && isSmsCommandId(attempt.commandId) ? attempt : undefined;
  }

  private async recordAck(input: AttemptIdentity, ack: SmsCommandAck): Promise<void> {
    if (typeof ack.ok !== 'boolean' || (ack.ok ? ack.error !== null : typeof ack.error !== 'string' || !ack.error || ack.error === 'SMS_RESULT_CONFLICT')) throw new Error('Invalid SMS ACK');
    await this.transact(async client => {
      if (!await this.lockTask(client, input) || (await this.locate(client, input.taskId))?.commandId !== input.commandId) {
        throw new Error('SMS ACK attempt is unverified');
      }
      // Commit observations separately so projection failure cannot erase an ACK.
      await client.query('INSERT INTO sms_dispatch_ack_evidence(command_id,ok,error_code) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [input.commandId, ack.ok, ack.error]);
    });
  }

  private async finish(input: AttemptIdentity, markUnknown: boolean, uncertainXid?: string): Promise<void> {
    await this.transact(async client => {
      // Wait on the same task lock before checking a lost COMMIT. A matching tuple
      // alone could have been inserted by another transaction after a rollback.
      const locked = await this.lockTask(client, input);
      if (uncertainXid !== undefined) {
        const outcome = await client.query<{ status: string | null }>('SELECT pg_xact_status($1::xid8) AS status', [uncertainXid]);
        const status = outcome.rows[0]?.status;
        if (status === 'aborted') return;
        if (status !== 'committed') throw new Error('SMS claim transaction outcome is unresolved');
      }
      if (!locked || (await this.locate(client, input.taskId))?.commandId !== input.commandId) {
        throw new Error('SMS dispatch attempt is unverified');
      }
      await this.projectLocked(client, input.taskId, input.commandId, markUnknown);
    });
  }

  private async projectLocked(client: Client, taskId: string, commandId: string | undefined, markUnknown: boolean): Promise<void> {
    const observations = commandId === undefined ? [] : (await client.query<{ ok: boolean; error_code: string | null }>(
      'SELECT ok,error_code FROM sms_dispatch_ack_evidence WHERE command_id=$1 ORDER BY evidence_id LIMIT 2', [commandId],
    )).rows;
    const ack = observations[0];
    let updated: pg.QueryResult | undefined;
    if (observations.length > 1) {
      updated = await client.query("UPDATE sms_task SET state='unknown',error_code='SMS_RESULT_CONFLICT',updated_at=now() WHERE id=$1 AND state IN ('dispatched','accepted','unknown','failed','sent','delivered') AND (state<>'unknown' OR error_code IS DISTINCT FROM 'SMS_RESULT_CONFLICT')", [taskId]);
    } else if (ack?.ok) {
      updated = await client.query("UPDATE sms_task SET state='accepted',error_code=NULL,updated_at=now() WHERE id=$1 AND state='dispatched'", [taskId]);
    } else if (ack) {
      updated = await client.query(`UPDATE sms_task SET state=CASE WHEN state='dispatched' THEN 'failed' ELSE state END,
        error_code=CASE WHEN state='dispatched' THEN $2 ELSE error_code END,negative_ack=true,updated_at=now()
        WHERE id=$1 AND state IN ('dispatched','accepted','unknown','failed','sent','delivered') AND (state='dispatched' OR NOT negative_ack)`, [taskId, ack.error_code]);
    } else if (markUnknown) {
      updated = await client.query("UPDATE sms_task SET state='unknown',updated_at=now() WHERE id=$1 AND state='dispatched'", [taskId]);
    }
    if (updated?.rowCount === 1) {
      await replaySmsResults(client, taskId, true);
    }
  }

  /** Startup only, after exclusive Core ownership and before any dispatch is admitted. */
  async reconcile(assertOwnership: () => void = () => {}): Promise<number> {
    let count = 0;
    for (;;) {
      assertOwnership();
      const batch = await this.transact(async client => {
        const tasks = await client.query<{ id: string }>("SELECT id FROM sms_task WHERE state='dispatched' ORDER BY id LIMIT 100 FOR UPDATE");
        assertOwnership();
        for (const task of tasks.rows) {
          const attempt = await this.locate(client, task.id);
          // Legacy rows have no proven command/ACK identity. Recover only the task
          // projection and any existing task-bound sms.result under its row lock.
          await this.projectLocked(client, task.id, attempt?.commandId, true);
        }
        assertOwnership();
        return tasks.rows.length;
      });
      count += batch;
      if (batch < 100) return count;
    }
  }
}
