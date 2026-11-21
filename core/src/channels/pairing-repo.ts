import type pg from 'pg';
import { ulid } from 'ulid';
import { transaction } from '../db/pool.js';
export type PairingPlatform = 'qq' | 'telegram';
export interface PairedIdentity { id: string; platform: PairingPlatform; platformUserId: string; displayName: string | null; pairedAt: number }
export type Redemption = { status: 'paired'; pairedUser: PairedIdentity; replacedUser: PairedIdentity | null } | { status: 'invalid' | 'locked' };
export class PairingRepository {
  constructor(private readonly pool: pg.Pool) {}
  private async transaction<T>(platform: PairingPlatform, work: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    return transaction(this.pool, async client => {
      const locked = await client.query('SELECT platform FROM channel WHERE platform=$1 FOR UPDATE', [platform]);
      if (locked.rowCount !== 1) throw new Error('Unknown pairing platform');
      return work(client);
    });
  }
  async issue(platform: PairingPlatform, hash: Buffer): Promise<number> {
    return this.transaction(platform, async client => {
      await client.query('UPDATE pairing_code SET used_at=clock_timestamp() WHERE platform=$1 AND used_at IS NULL', [platform]);
      const result = await client.query<{ expiresAt: string }>("INSERT INTO pairing_code(id,platform,code_hash,expires_at) VALUES($1,$2,$3,clock_timestamp()+interval '5 minutes') RETURNING (extract(epoch from expires_at)*1000)::text AS \"expiresAt\"", [ulid(), platform, hash]);
      return Number(result.rows[0]!.expiresAt);
    });
  }
  async redeem(platform: PairingPlatform, hash: Buffer, senderId: string, displayName: string | null): Promise<Redemption> {
    return this.transaction(platform, client => this.redeemInTransaction(client, platform, hash, senderId, displayName));
  }
  /** Caller must own the transaction. No external effects. */
  async redeemInTransaction(client: pg.PoolClient, platform: PairingPlatform, hash: Buffer, senderId: string, displayName: string | null): Promise<Redemption> {
    const locked = await client.query('SELECT platform FROM channel WHERE platform=$1 FOR UPDATE', [platform]);
    if (locked.rowCount !== 1) throw new Error('Unknown pairing platform');
      const lock = await client.query("SELECT 1 FROM pairing_lock WHERE platform=$1 AND sender_id=$2 AND locked_until>clock_timestamp()", [platform, senderId]);
      if (lock.rowCount) return { status: 'locked' };
      const consumed = await client.query('UPDATE pairing_code SET used_at=clock_timestamp(),used_by=$3 WHERE platform=$1 AND code_hash=$2 AND used_at IS NULL AND expires_at>clock_timestamp() RETURNING id', [platform, hash, senderId]);
      const ok = consumed.rowCount === 1;
      await client.query('INSERT INTO pairing_attempt(id,platform,sender_id,ok,ts) VALUES($1,$2,$3,$4,clock_timestamp())', [ulid(), platform, senderId, ok]);
      if (!ok) {
        const attempts = await client.query<{ count: string }>("SELECT count(*)::text AS count FROM pairing_attempt WHERE platform=$1 AND sender_id=$2 AND NOT ok AND ts > clock_timestamp()-interval '10 minutes'", [platform, senderId]);
        if (Number(attempts.rows[0]!.count) >= 5) await client.query("INSERT INTO pairing_lock(platform,sender_id,locked_until) VALUES($1,$2,clock_timestamp()+interval '30 minutes') ON CONFLICT (platform,sender_id) DO UPDATE SET locked_until=EXCLUDED.locked_until", [platform, senderId]);
        return { status: 'invalid' };
      }
      const previous = await client.query<PairedIdentity>("UPDATE paired_user SET revoked_at=clock_timestamp(),revoke_reason='replaced' WHERE platform=$1 AND revoked_at IS NULL RETURNING id,platform,platform_user_id AS \"platformUserId\",display_name AS \"displayName\",(extract(epoch from paired_at)*1000)::float8 AS \"pairedAt\"", [platform]);
      const inserted = await client.query<PairedIdentity>('INSERT INTO paired_user(id,platform,platform_user_id,display_name) VALUES($1,$2,$3,$4) RETURNING id,platform,platform_user_id AS "platformUserId",display_name AS "displayName",(extract(epoch from paired_at)*1000)::float8 AS "pairedAt"', [ulid(), platform, senderId, displayName]);
      return { status: 'paired', pairedUser: inserted.rows[0]!, replacedUser: previous.rows[0] ?? null };
  }
}
