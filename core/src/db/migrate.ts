import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type pg from 'pg';
import { TransactionCommitUnknown, TransactionRolledBack } from './pool.js';

const lockKey = 198247301;

export async function migrate(pool: pg.Pool, directory: string, assertOwnership: () => void = () => {}): Promise<void> {
  const files = (await readdir(directory)).filter(name => /^\d{4}_.+\.sql$/.test(name)).sort();
  const versions = files.map(file => Number(file.slice(0, 4)));
  if (new Set(versions).size !== versions.length) throw new Error('Duplicate migration version');

  const client = await pool.connect();
  const errors: unknown[] = [];
  let lockAttempted = false;
  let transactionMayBeOpen = false;
  try {
    // A rejected query can still have reached the server, so cleanup is attempted
    // even when the response to lock acquisition or BEGIN is lost.
    lockAttempted = true;
    await client.query('SELECT pg_advisory_lock($1)', [lockKey]);
    assertOwnership();
    await client.query('CREATE TABLE IF NOT EXISTS schema_migration(version int primary key, applied_at timestamptz not null default now())');
    for (const file of files) {
      const version = Number(file.slice(0, 4));
      const exists = await client.query('SELECT 1 FROM schema_migration WHERE version = $1', [version]);
      if (exists.rowCount) continue;
      const sql = await readFile(join(directory, file), 'utf8');
      assertOwnership();
      transactionMayBeOpen = true;
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO schema_migration(version) VALUES ($1)', [version]);
      assertOwnership();
      let result: pg.QueryResult;
      try {
        result = await client.query('COMMIT');
      } catch (error) {
        throw new TransactionCommitUnknown(error);
      }
      if (result.command === 'ROLLBACK') throw new TransactionRolledBack();
      if (result.command !== 'COMMIT') {
        throw new TransactionCommitUnknown(new Error('Unexpected COMMIT response: ' + String(result.command)));
      }
      transactionMayBeOpen = false;
    }
  } catch (error) {
    errors.push(error);
  }

  if (transactionMayBeOpen) {
    try {
      const result = await client.query('ROLLBACK');
      if (result.command !== 'ROLLBACK') {
        throw new Error('Migration ROLLBACK was not confirmed: ' + String(result.command));
      }
    } catch (error) {
      errors.push(error);
    }
  }
  if (lockAttempted) {
    try {
      const result = await client.query('SELECT pg_advisory_unlock($1) AS unlocked', [lockKey]);
      if (result.rows.length !== 1 || result.rows[0]?.unlocked !== true) {
        throw new Error('Migration advisory lock was not confirmed unlocked');
      }
    } catch (error) {
      errors.push(error);
    }
  }
  try {
    // Any failure leaves the session or commit outcome uncertain. Destroy it.
    client.release(errors.length > 0);
  } catch (error) {
    errors.push(error);
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, 'Migration failed and cleanup also failed');
}
