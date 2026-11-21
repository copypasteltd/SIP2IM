import pg from 'pg';
import type { Config } from '../config/load.js';

// A separate advisory-lock key from the migration lock. All Core instances
// accessing the same database must use this exact key.
export const CORE_OWNERSHIP_LOCK_KEY = 198247302;

export interface OwnershipClient {
  connect(): Promise<unknown>;
  query(sql: string, values: number[]): Promise<{ rows: Array<{ acquired: boolean }> }>;
  end(): Promise<void>;
  on(event: 'error', listener: (error: Error) => void): this;
  on(event: 'end', listener: () => void): this;
}

export interface OwnershipGuard {
  /** Throws after the session has been lost or close has begun. */
  assertHeld(): void;
  /** Close only after every protected operation and external effect is quiescent. */
  close(): Promise<void>;
}

/**
 * Acquire a session lock on a dedicated, direct PostgreSQL connection. Never
 * use a pool or transaction-pooling proxy: the same backend must stay pinned.
 * onLost must synchronously initiate a fatal halt of all protected work; this
 * helper cannot fence a paused process or reverse already in-flight effects.
 * Optional probes check that this exact backend still holds the lock. They
 * bound local staleness but cannot fence another server during failover.
 * A cleanup timeout is an unknown session outcome: do not retry or take over
 * until external evidence establishes that the old session has ended.
 */
export async function acquireCoreOwnership(
  config: Config['database'],
  onLost: (error: Error) => void,
  createClient: () => OwnershipClient = () => new pg.Client({ ...config, connectionTimeoutMillis: 10000, keepAlive: true }),
  timeoutMs = 10000,
  probeIntervalMs = 0,
): Promise<OwnershipGuard> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new Error('Invalid ownership timeout');
  if (!Number.isSafeInteger(probeIntervalMs) || probeIntervalMs < 0) throw new Error('Invalid ownership probe interval');
  const client = createClient();
  let rejectLoss!: (error: Error) => void;
  const lossSignal = new Promise<never>((_, reject) => { rejectLoss = reject; });
  void lossSignal.catch(() => {});
  const bounded = async <T>(operation: Promise<T>, label: string): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(label + ' timed out')), timeoutMs); });
    try { return await Promise.race([operation, timeout]); } finally { clearTimeout(timer); }
  };
  let state: 'acquiring' | 'held' | 'lost' | 'closing' | 'closed' = 'acquiring';
  let loss: Error | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let checkedAt = performance.now();
  const lost = (error: Error) => {
    if (state === 'closing' || state === 'closed' || state === 'lost') return;
    const wasHeld = state === 'held';
    state = 'lost';
    clearTimeout(timer);
    loss = error;
    rejectLoss(error);
    if (wasHeld) onLost(error);
  };
  client.on('error', lost);
  client.on('end', () => lost(new Error('Core ownership connection ended')));
  try {
    await bounded(Promise.race([client.connect(), lossSignal]), 'Core ownership connection');
    if (loss) throw loss;
    const result = await bounded(Promise.race([client.query('SELECT pg_try_advisory_lock($1) AS acquired', [CORE_OWNERSHIP_LOCK_KEY]), lossSignal]), 'Core ownership acquisition');
    if (loss) throw loss;
    if (result.rows.length !== 1 || result.rows[0]?.acquired !== true) {
      throw new Error('Core database ownership lock is unavailable');
    }
    state = 'held';
  } catch (error) {
    state = 'closing';
    // End the entire dedicated session even if acquisition had an ambiguous
    // outcome. Do not unlock separately or return a possibly locked client.
    try { await bounded(client.end(), 'Core ownership cleanup'); } catch (cleanupError) {
      state = 'closed';
      throw new AggregateError([error, cleanupError], 'Core ownership acquisition failed and session cleanup is uncertain');
    }
    state = 'closed';
    throw error;
  }
  const check = async () => {
    if (state !== 'held') return;
    const started = performance.now();
    try {
      const result = await bounded(Promise.race([
        client.query(`SELECT EXISTS (SELECT 1 FROM pg_locks
          WHERE locktype='advisory' AND pid=pg_backend_pid() AND mode='ExclusiveLock' AND granted
            AND database=(SELECT oid FROM pg_database WHERE datname=current_database())
            AND classid=0::oid AND objid=$1::oid AND objsubid=1) AS acquired`, [CORE_OWNERSHIP_LOCK_KEY]),
        lossSignal,
      ]), 'Core ownership probe');
      if (state !== 'held') return;
      if (result.rows.length !== 1 || result.rows[0]?.acquired !== true) throw new Error('Core ownership no longer held');
      checkedAt = started;
      timer = setTimeout(() => { void check(); }, probeIntervalMs);
    } catch (error) {
      lost(error instanceof Error ? error : new Error('Core ownership probe failed'));
    }
  };
  checkedAt = performance.now();
  if (probeIntervalMs) timer = setTimeout(() => { void check(); }, probeIntervalMs);
  let closing: Promise<void> | undefined;
  return {
    assertHeld() {
      if (state === 'held' && probeIntervalMs && performance.now() - checkedAt >= probeIntervalMs + timeoutMs) {
        lost(new Error('Core ownership evidence expired'));
      }
      if (state !== 'held') throw loss ?? new Error('Core database ownership is not held');
    },
    close() {
      if (!closing) {
        clearTimeout(timer);
        state = 'closing';
        closing = bounded(Promise.resolve().then(() => client.end()), 'Core ownership cleanup').finally(() => { state = 'closed'; });
      }
      return closing;
    },
  };
}
