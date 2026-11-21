import pg from 'pg';
import type { Config } from '../config/load.js';
export function createPool(config: Config['database']): pg.Pool { return new pg.Pool({ ...config, max: 10, connectionTimeoutMillis: 10000, query_timeout: 10000, statement_timeout: 10000 }); }

export class TransactionCommitUnknown extends Error {
  constructor(cause: unknown) { super('Transaction COMMIT outcome is uncertain', { cause }); this.name = 'TransactionCommitUnknown'; }
}
export class TransactionRolledBack extends Error {
  constructor() { super('COMMIT returned ROLLBACK; transaction was not committed'); this.name = 'TransactionRolledBack'; }
}
export class TransactionReleaseFailed extends Error {
  constructor(cause: unknown) { super('Transaction committed but client release failed', { cause }); this.name = 'TransactionReleaseFailed'; }
}

export async function transaction<T>(pool: pg.Pool, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  let failed = false;
  let failure: unknown;
  let result!: T;
  let committing = false;
  try {
    await client.query('BEGIN');
    result = await fn(client);
    committing = true;
    const commit = await client.query('COMMIT');
    if (commit.command === 'ROLLBACK') {
      committing = false;
      throw new TransactionRolledBack();
    }
    if (commit.command !== 'COMMIT') throw new Error('Unexpected COMMIT command tag: ' + String(commit.command));
  } catch (error) {
    failed = true;
    // A successful ROLLBACK after a lost COMMIT response cannot prove that
    // COMMIT did not already take effect. Keep that uncertainty explicit.
    failure = committing ? new TransactionCommitUnknown(error) : error;
    try {
      const rollback = await client.query('ROLLBACK');
      if (rollback.command !== 'ROLLBACK') throw new Error('Unexpected ROLLBACK command tag: ' + String(rollback.command));
    } catch (rollbackError) {
      // Keep the original object nested: callers must not mistake an uncertain
      // rollback for a safely rolled-back application error (e.g. an SMS race).
      failure = new AggregateError([failure, rollbackError], 'Transaction failed and rollback failed');
    }
  }
  try {
    // An error may be a connection failure or an uncertain COMMIT, even when
    // a later ROLLBACK responds. pg-pool removes a client released with true.
    if (failed) client.release(true);
    else client.release();
  } catch (releaseError) {
    if (failed) throw new AggregateError([failure, releaseError], 'Transaction failed and client release failed');
    throw new TransactionReleaseFailed(releaseError);
  }
  if (failed) throw failure;
  return result;
}
