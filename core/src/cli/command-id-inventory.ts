import type { Pool, PoolClient } from 'pg';
import { INVENTORY_LIMITATIONS, inventoryCommandIds } from '../db/command-id-inventory.js';

export function parseInventoryOptions(args: string[]): { pageSize: number; maxRows: number | null } {
  let pageSize = 100, maxRows: number | null = null;
  const seen = new Set<string>();
  for (let i = 0; i < args.length; i += 2) {
    const flag = args[i]!, raw = args[i + 1];
    if (!['--page-size', '--max-rows'].includes(flag) || seen.has(flag) || !raw || !/^[1-9][0-9]*$/.test(raw)) throw new Error('usage: command-id:inventory [--page-size 1..1000] [--max-rows positive-integer]');
    seen.add(flag);
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || (flag === '--page-size' && value > 1000)) throw new Error('invalid inventory limit');
    if (flag === '--page-size') pageSize = value; else maxRows = value;
  }
  return { pageSize, maxRows };
}

/** The sink must resolve only after the record is accepted; failures make output partial. */
export async function runCommandInventory(
  pool: Pick<Pool, 'connect' | 'end'>,
  options: { pageSize: number; maxRows: number | null },
  write: (record: unknown) => Promise<void>,
): Promise<boolean> {
  let client: PoolClient | undefined;
  let failed = false, began = false, complete = false, count = 0;
  let stage = 'metadata'; const errors: string[] = [];
  let cursor: string | null = null;
  try {
    await write({ type: 'metadata', version: 1, limitations: INVENTORY_LIMITATIONS });
    stage = 'connect'; client = await pool.connect();
    stage = 'begin'; await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    began = true;
    do {
      const limit = options.maxRows === null ? options.pageSize : Math.min(options.pageSize, options.maxRows - count);
      stage = 'query'; const page = await inventoryCommandIds(client, { limit, after: cursor });
      for (const row of page.rows) { stage = 'output'; await write({ type: 'row', row }); count++; }
      cursor = page.nextCursor;
      if (cursor === null) { complete = true; break; }
    } while (options.maxRows === null || count < options.maxRows);
    stage = 'commit'; const result = await client.query('COMMIT');
    if (result.command !== 'COMMIT') throw new Error('transaction did not commit');
    began = false;
  } catch {
    failed = true; complete = false; errors.push(stage);
    if (client && began) { try { const result = await client.query('ROLLBACK'); if (result.command !== 'ROLLBACK') throw new Error('rollback failed'); } catch { errors.push('rollback'); } }
  } finally {
    if (client) { try { client.release(failed); } catch { failed = true; complete = false; errors.push('release'); } }
    try { await pool.end(); } catch { failed = true; complete = false; errors.push('pool_end'); }
  }
  try {
    await write({ type: 'status', complete: complete && !failed, rows: count,
      reason: failed ? 'error' : complete ? null : 'max_rows',
      continuation: !failed && !complete ? cursor : null, errors });
  } catch { return false; }
  return complete && !failed;
}
