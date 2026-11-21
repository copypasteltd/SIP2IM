import type pg from 'pg';
import { transaction } from '../db/pool.js';

export async function lockDevice(client: pg.PoolClient, id: string) {
  const result = await client.query<{ revoked_at: Date | null }>(
    'SELECT revoked_at FROM device WHERE id=$1 FOR UPDATE', [id],
  );
  return result.rows[0];
}

/** Call with the code row(s) and device already locked. */
export async function revokeLockedDevice(client: pg.PoolClient, id: string): Promise<boolean> {
  await client.query(
    'SELECT token_hash FROM device_credential WHERE device_id=$1 ORDER BY token_hash FOR UPDATE', [id],
  );
  const result = await client.query(
    'UPDATE device SET revoked_at=now(),online=false,updated_at=now() WHERE id=$1 AND revoked_at IS NULL', [id],
  );
  await client.query('UPDATE device_credential SET revoked_at=now() WHERE device_id=$1 AND revoked_at IS NULL', [id]);
  return result.rowCount === 1;
}

async function linkedCodes(client: pg.PoolClient, id: string): Promise<Buffer[]> {
  const result = await client.query<{ code_hash: Buffer }>(
    'SELECT code_hash FROM binding_code WHERE used_by_device=$1 ORDER BY code_hash', [id],
  );
  return result.rows.map(row => row.code_hash);
}

class BindingAssociationChanged extends Error {}

export async function revokeBoundDevice(pool: pg.Pool, id: string): Promise<boolean> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await transaction(pool, async client => {
        await client.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED');
        await client.query('SET LOCAL synchronous_commit = on');
        const codes = await linkedCodes(client, id);
        for (const code of codes) {
          await client.query('SELECT code_hash FROM binding_code WHERE code_hash=$1 FOR UPDATE', [code]);
        }
        const device = await lockDevice(client, id);
        const current = await linkedCodes(client, id);
        if (current.length !== codes.length || current.some((code, index) => !code.equals(codes[index]!))) {
          throw new BindingAssociationChanged();
        }
        if (!device || device.revoked_at !== null) return false;
        return revokeLockedDevice(client, id);
      });
    } catch (error) {
      // Only a revalidation failure with confirmed rollback can retry here.
      if (!(error instanceof BindingAssociationChanged) || attempt >= 2) throw error;
    }
  }
}
