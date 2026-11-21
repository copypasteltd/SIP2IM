import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { platformMessageIdentity, type PlatformMessageIdentity } from '@voipgw/protocol';
import { transaction } from '../db/pool.js';
import { inboundSchema, type InboundMessage, type MessagePlatform } from './message-router.js';
import type { Redemption } from './pairing-repo.js';

export type InboxKey = { platform: MessagePlatform; identity: PlatformMessageIdentity };
export type InboxLease = InboxKey & { token: string; message: InboundMessage };
export type ReceiveResult = 'inserted' | 'duplicate' | 'collision' | 'legacy';
/** Caller must obtain this from the authenticated live adapter session, never the message payload. */
export type VerifiedAdapterContext = { platform: MessagePlatform; verifiedAccountId: string };
const where = 'platform=$1 AND account_id=$2 AND peer_type=$3 AND peer_id=$4 AND namespace=$5 AND message_id=$6';
function values(key: InboxKey): [string,string,string,string,string,string] {
  const identity = platformMessageIdentity.parse(key.identity);
  if (key.platform !== 'qq' && key.platform !== 'telegram') throw new Error('invalid platform');
  return [key.platform, identity.accountId, identity.peer.type, identity.peer.id, identity.namespace, identity.messageId];
}
function sameIdentity(a: PlatformMessageIdentity, b: PlatformMessageIdentity): boolean {
  return a.version === b.version && a.accountId === b.accountId && a.peer.type === b.peer.type && a.peer.id === b.peer.id && a.namespace === b.namespace && a.messageId === b.messageId;
}

/** Receipt only; this does not connect adapters or enable runtime processing. */
export class PlatformInboxRepository {
  constructor(private readonly pool: pg.Pool) {}

  async receive(context: VerifiedAdapterContext, input: InboundMessage): Promise<ReceiveResult> {
    const message = inboundSchema.parse(input);
    const identity = platformMessageIdentity.parse(message.identity);
    if (context.verifiedAccountId !== identity.accountId || message.platformMessageId !== identity.messageId) throw new Error('unverified or inconsistent identity');
    if (message.chatType !== 'private' || message.forwarded || identity.peer.type !== 'user' || identity.peer.id !== message.senderId) throw new Error('unsupported message scope');
    const key = values({platform:context.platform,identity});
    return transaction(this.pool, async client => {
      // An old id cannot be assigned to any account or peer safely, even if its payload looks similar.
      const legacy = await client.query(
        `SELECT 1 FROM platform_inbox WHERE platform=$1 AND platform_message_id=$2
         UNION ALL SELECT 1 FROM platform_message WHERE platform=$1 AND direction='in' AND platform_message_id=$2 LIMIT 1`,
        [context.platform, identity.messageId]);
      if (legacy.rowCount !== 0) return 'legacy';
      const payload = JSON.stringify(message);
      const inserted = await client.query(
        `INSERT INTO platform_inbox_v1(platform,account_id,peer_type,peer_id,namespace,message_id,payload)
         VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb) ON CONFLICT DO NOTHING RETURNING platform`, [...key,payload]);
      if (inserted.rowCount === 1) return 'inserted';
      const existing = await client.query<{same:boolean; collision_detected:boolean}>(`SELECT payload=$7::jsonb AS same, collision_detected FROM platform_inbox_v1 WHERE ${where} FOR UPDATE`, [...key,payload]);
      if (existing.rowCount !== 1) throw new Error('inbox conflict row unavailable');
      if (existing.rows[0]!.same === true && !existing.rows[0]!.collision_detected) return 'duplicate';
      // Lock serializes with completion. A completed decision is retained, not undone.
      const marked = await client.query(`UPDATE platform_inbox_v1 SET collision_detected=true, state=CASE WHEN state='completed' THEN state ELSE 'quarantined' END, lease_token=NULL, lease_until=NULL WHERE ${where}`, key);
      if (marked.rowCount !== 1) throw new Error('inbox collision quarantine failed');
      return 'collision';
    });
  }

  async processPairing(lease: InboxLease): Promise<{status:'completed';outcome:Redemption}|{status:'stale'|'unsupported'}> {
    const key = values(lease);
    return transaction(this.pool, async client => {
      const locked = await client.query<{payload:unknown}>(`SELECT payload FROM platform_inbox_v1 WHERE ${where} AND state='processing' AND lease_token=$7::uuid AND lease_until > clock_timestamp() FOR UPDATE`, [...key,lease.token]);
      if (locked.rowCount !== 1) return {status:'stale'};
      const parsed = inboundSchema.safeParse(locked.rows[0]!.payload);
      if (!parsed.success || !parsed.data.identity || !sameIdentity(parsed.data.identity,lease.identity) || parsed.data.platformMessageId !== lease.identity.messageId || parsed.data.chatType !== 'private' || parsed.data.forwarded || lease.identity.peer.type !== 'user' || parsed.data.senderId !== lease.identity.peer.id) throw new Error('invalid inbox payload');
      // No trusted session generation is persisted yet. Account changes cannot be fenced,
      // so even pairing commands must remain deferred without redeeming a code.
      const deferred = await client.query(`UPDATE platform_inbox_v1 SET state='deferred',lease_token=NULL,lease_until=NULL WHERE ${where} AND state='processing' AND lease_token=$7::uuid AND lease_until > clock_timestamp()`, [...key,lease.token]);
      if (deferred.rowCount !== 1) throw new Error('inbox lease expired during deferral');
      return {status:'unsupported'};
    });
  }

  async pairingOutcome(key: InboxKey): Promise<Redemption|null> {
    const result = await this.pool.query<{pairing_outcome:Redemption|null}>(`SELECT pairing_outcome FROM platform_inbox_v1 WHERE ${where} AND state='completed'`, values(key));
    return result.rows[0]?.pairing_outcome ?? null;
  }

  async claim(leaseMs:number): Promise<InboxLease|null> {
    if (!Number.isSafeInteger(leaseMs) || leaseMs < 1 || leaseMs > 3_600_000) throw new Error('invalid inbox lease');
    const token = randomUUID();
    const result = await this.pool.query<{platform:MessagePlatform;account_id:string;peer_type:'user'|'group'|'channel';peer_id:string;namespace:'server';message_id:string;payload:InboundMessage}>(
      `WITH candidate AS (SELECT platform,account_id,peer_type,peer_id,namespace,message_id FROM platform_inbox_v1
       WHERE state='pending' OR (state='processing' AND lease_until <= clock_timestamp())
       ORDER BY received_at,platform,account_id,peer_type,peer_id,namespace,message_id FOR UPDATE SKIP LOCKED LIMIT 1)
       UPDATE platform_inbox_v1 AS inbox SET state='processing',lease_token=$1::uuid,lease_until=clock_timestamp()+($2::double precision * interval '1 millisecond')
       FROM candidate WHERE (inbox.platform,inbox.account_id,inbox.peer_type,inbox.peer_id,inbox.namespace,inbox.message_id)=(candidate.platform,candidate.account_id,candidate.peer_type,candidate.peer_id,candidate.namespace,candidate.message_id)
       RETURNING inbox.platform,inbox.account_id,inbox.peer_type,inbox.peer_id,inbox.namespace,inbox.message_id,inbox.payload`, [token,leaseMs]);
    const row = result.rows[0];
    if (!row) return null;
    const identity = platformMessageIdentity.parse({version:1,accountId:row.account_id,peer:{type:row.peer_type,id:row.peer_id},namespace:row.namespace,messageId:row.message_id});
    return {platform:row.platform,identity,token,message:row.payload};
  }

  /** Always rejects until the originating adapter session generation can be verified. */
  async complete<T>(_lease:InboxLease,_work:(client:pg.PoolClient,message:InboundMessage)=>Promise<T>):Promise<never> {
    throw new Error('inbox completion requires trusted adapter generation verification');
  }
}
