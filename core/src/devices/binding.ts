import { randomInt, timingSafeEqual } from 'node:crypto';
import type pg from 'pg';
import { ulid } from 'ulid';
import { newToken, tokenHash } from '../auth/service.js';
import { transaction } from '../db/pool.js';
import { lockDevice, revokeLockedDevice } from './device-revocation.js';

export interface BindInput {
  code: string;
  manufacturer: string;
  model: string;
  apiLevel: number;
  apkVersion: string;
  apkCode: number;
  locale: string;
}

export interface BindV2Input extends BindInput {
  protocolVersion: 2;
  attemptId: string;
}

type BindError = { error: 'BINDING_INVALID' | 'BINDING_EXPIRED' };
export type BindResult = { deviceId: string; token: string } | BindError;
export type BindV2Result = { protocolVersion: 2; attemptId: string; deviceId: string } | BindError;
export type BindingCancellation = { deviceId: string | null; teardownPending: boolean };

interface CodeRow {
  expires_at: Date;
  used_at: Date | null;
  used_by_device: string | null;
}

interface CodeControl {
  cancelled_at: Date | null;
  protocol_version: number | null;
  attempt_id: Buffer | null;
  credential_hash: Buffer | null;
  request_fingerprint: Buffer | null;
  teardown_pending: boolean;
}

interface CodeInventoryRow extends CodeRow {
  record_id: string;
  created_at: Date;
  cancelled_at: Date | null;
  protocol_version: number | null;
  teardown_pending: boolean;
}

class BindWriteRejected extends Error {
  constructor(readonly result: BindError) { super(result.error); }
}

async function bindingTransaction<T>(pool: pg.Pool, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  return transaction(pool, async client => {
    await client.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED');
    await client.query('SET LOCAL synchronous_commit = on');
    return fn(client);
  });
}

async function lockCode(client: pg.PoolClient, codeHash: Buffer) {
  const code = (await client.query<CodeRow>(
    'SELECT expires_at, used_at, used_by_device FROM binding_code WHERE code_hash=$1 FOR UPDATE', [codeHash],
  )).rows[0];
  if (!code) return null;
  // A fresh snapshot after any wait for the parent row sees committed evidence.
  const state = (await client.query<CodeControl>(
    `SELECT cancelled_at, protocol_version, attempt_id, credential_hash, request_fingerprint, teardown_pending
     FROM binding_code_control WHERE code_hash=$1`, [codeHash],
  )).rows[0];
  if (!state) throw new Error('Binding code control record missing');
  return { code, state };
}

async function insertDevice(client: pg.PoolClient, id: string, input: BindInput): Promise<void> {
  await client.query(
    `INSERT INTO device(id,name,manufacturer,model,api_level,apk_version,apk_code,locale)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [id, input.model, input.manufacturer, input.model, input.apiLevel, input.apkVersion, input.apkCode, input.locale],
  );
}

function immutableFingerprint(input: BindV2Input): Buffer {
  // A fixed typed tuple encoded as UTF-8 JSON. Strings are as validated on the
  // wire, without trimming, case folding or Unicode normalization. Positions
  // and JSON escaping disambiguate all accepted metadata, including separators.
  return tokenHash(JSON.stringify([
    'voipgw.device.bind', 2, input.manufacturer, input.model, input.apiLevel,
    input.apkVersion, input.apkCode, input.locale,
  ]));
}

function equalHash(stored: Buffer | null, presented: Buffer): boolean {
  return stored !== null && stored.length === presented.length && timingSafeEqual(stored, presented);
}

export class BindingRepository {
  constructor(private readonly pool: pg.Pool) {}

  async createCode(): Promise<{ code: string; expiresAt: number; recordId: string }> {
    for (let attempt = 0; attempt < 10; attempt++) {
      const code = String(randomInt(1000000)).padStart(6, '0');
      const expiresAt = Date.now() + 600000;
      const inserted = await this.pool.query<{ record_id: string }>(`WITH issued AS (
        INSERT INTO binding_code(code_hash,expires_at) VALUES ($1,$2) ON CONFLICT DO NOTHING RETURNING code_hash
      ) INSERT INTO binding_code_control(code_hash) SELECT code_hash FROM issued RETURNING record_id`,
      [tokenHash(code), new Date(expiresAt)]);
      if (inserted.rows[0]) return { code, expiresAt, recordId: inserted.rows[0].record_id };
    }
    throw new Error('Unable to allocate binding code');
  }

  async bind(input: BindInput): Promise<BindResult> {
    return bindingTransaction(this.pool, async client => {
      const codeHash = tokenHash(input.code);
      const locked = await lockCode(client, codeHash);
      if (!locked || locked.state.cancelled_at || locked.code.used_at) return { error: 'BINDING_INVALID' };
      if (locked.code.expires_at.getTime() <= Date.now()) return { error: 'BINDING_EXPIRED' };
      const deviceId = 'dev_' + ulid();
      const token = newToken();
      await insertDevice(client, deviceId, input);
      await client.query('INSERT INTO device_credential(token_hash,device_id) VALUES ($1,$2)', [tokenHash(token), deviceId]);
      await client.query('UPDATE binding_code SET used_at=now(),used_by_device=$2 WHERE code_hash=$1', [codeHash, deviceId]);
      return { deviceId, token };
    });
  }

  async bindV2(input: BindV2Input, credentialHash: Buffer): Promise<BindV2Result> {
    const codeHash = tokenHash(input.code);
    const attemptId = Buffer.from(input.attemptId, 'base64url');
    const fingerprint = immutableFingerprint(input);
    try {
      return await bindingTransaction(this.pool, async client => {
        const locked = await lockCode(client, codeHash);
        if (!locked || locked.state.cancelled_at) return { error: 'BINDING_INVALID' };
        const { code, state } = locked;
        let deviceId: string;
        if (code.used_at !== null) {
          if (!code.used_by_device || state.protocol_version !== 2
            || !equalHash(state.credential_hash, credentialHash)
            || !state.attempt_id?.equals(attemptId)
            || !equalHash(state.request_fingerprint, fingerprint)) return { error: 'BINDING_INVALID' };
          deviceId = code.used_by_device;
          const device = await lockDevice(client, deviceId);
          if (!device || device.revoked_at !== null) return { error: 'BINDING_INVALID' };
          const credential = (await client.query<{ revoked_at: Date | null }>(
            'SELECT revoked_at FROM device_credential WHERE token_hash=$1 AND device_id=$2 FOR UPDATE',
            [credentialHash, deviceId],
          )).rows[0];
          const inWindow = await client.query(
            'SELECT 1 FROM binding_code_control WHERE code_hash=$1 AND replay_until > clock_timestamp()', [codeHash],
          );
          if (!credential || credential.revoked_at !== null || inWindow.rowCount !== 1) return { error: 'BINDING_INVALID' };
        } else {
          const unexpired = await client.query(
            'SELECT 1 FROM binding_code WHERE code_hash=$1 AND expires_at > clock_timestamp()', [codeHash],
          );
          if (unexpired.rowCount !== 1) return { error: 'BINDING_EXPIRED' };
          deviceId = 'dev_' + ulid();
          await insertDevice(client, deviceId, input);
          const inserted = await client.query(
            'INSERT INTO device_credential(token_hash,device_id) VALUES ($1,$2) ON CONFLICT (token_hash) DO NOTHING',
            [credentialHash, deviceId],
          );
          if (inserted.rowCount !== 1) throw new BindWriteRejected({ error: 'BINDING_INVALID' });
          const consumed = await client.query(`UPDATE binding_code SET used_at=clock_timestamp(),used_by_device=$2
            WHERE code_hash=$1 AND expires_at > clock_timestamp()`, [codeHash, deviceId]);
          if (consumed.rowCount !== 1) throw new BindWriteRejected({ error: 'BINDING_EXPIRED' });
          const recorded = await client.query(`UPDATE binding_code_control AS control
            SET protocol_version=2, attempt_id=$2, credential_hash=$3, request_fingerprint=$4,
                replay_until=code.expires_at + interval '24 hours'
            FROM binding_code AS code WHERE control.code_hash=$1 AND code.code_hash=control.code_hash`,
          [codeHash, attemptId, credentialHash, fingerprint]);
          if (recorded.rowCount !== 1) throw new Error('Binding replay evidence was not recorded');
        }
        return { protocolVersion: 2, attemptId: input.attemptId, deviceId };
      });
    } catch (error) {
      // transaction wraps failures of COMMIT, rollback or release separately.
      if (error instanceof BindWriteRejected) return error.result;
      throw error;
    }
  }

  async listCodes(cursor?: string) {
    const limit = 100;
    const result = await this.pool.query<CodeInventoryRow>(`SELECT b.record_id, c.created_at, c.expires_at,
      c.used_at, c.used_by_device, b.cancelled_at, b.protocol_version, b.teardown_pending
      FROM binding_code_control b JOIN binding_code c USING (code_hash)
      WHERE $1::uuid IS NULL OR b.record_id > $1::uuid ORDER BY b.record_id LIMIT $2`, [cursor ?? null, limit + 1]);
    const page = result.rows.slice(0, limit);
    return {
      data: page.map(row => ({
        recordId: row.record_id, createdAt: row.created_at.getTime(), expiresAt: row.expires_at.getTime(),
        usedAt: row.used_at?.getTime() ?? null, deviceId: row.used_by_device,
        cancelledAt: row.cancelled_at?.getTime() ?? null,
        protocolVersion: row.protocol_version ?? (row.used_at ? 1 : null),
        teardownPending: row.teardown_pending,
      })),
      nextCursor: result.rows.length > limit ? page.at(-1)!.record_id : null,
    };
  }

  async cancelCode(recordId: string): Promise<BindingCancellation | null> {
    return bindingTransaction(this.pool, async client => {
      const entry = (await client.query<{ code_hash: Buffer }>(
        'SELECT code_hash FROM binding_code_control WHERE record_id=$1', [recordId],
      )).rows[0];
      if (!entry) return null;
      const locked = await lockCode(client, entry.code_hash);
      if (!locked) throw new Error('Binding code control record has no parent');
      const deviceId = locked.code.used_by_device;
      if (locked.state.cancelled_at) return { deviceId, teardownPending: locked.state.teardown_pending };
      if (deviceId) {
        if (!await lockDevice(client, deviceId)) throw new Error('Bound device is missing');
        await revokeLockedDevice(client, deviceId);
      }
      const cancelled = await client.query(`UPDATE binding_code_control
        SET cancelled_at=clock_timestamp(),teardown_pending=$2 WHERE code_hash=$1`,
      [entry.code_hash, deviceId !== null]);
      if (cancelled.rowCount !== 1) throw new Error('Binding cancellation was not recorded');
      return { deviceId, teardownPending: deviceId !== null };
    });
  }

  /** Call only after the existing session and media revocation effects succeed. */
  async markTeardownComplete(recordId: string): Promise<void> {
    await bindingTransaction(this.pool, async client => {
      const entry = (await client.query<{ code_hash: Buffer }>(`SELECT c.code_hash FROM binding_code c
        JOIN binding_code_control b USING (code_hash) WHERE b.record_id=$1 FOR UPDATE OF c`, [recordId])).rows[0];
      if (!entry) throw new Error('Binding code is missing');
      const completed = await client.query(`UPDATE binding_code_control SET teardown_pending=false
        WHERE code_hash=$1 AND cancelled_at IS NOT NULL`, [entry.code_hash]);
      if (completed.rowCount !== 1) throw new Error('Binding cancellation is missing');
    });
  }

  async authenticate(token: string): Promise<{ id: string; enabled: boolean } | null> {
    const result = await this.pool.query<{ id: string; enabled: boolean }>(
      `SELECT d.id,d.enabled FROM device_credential c JOIN device d ON d.id=c.device_id
       WHERE c.token_hash=$1 AND c.revoked_at IS NULL AND d.revoked_at IS NULL`, [tokenHash(token)],
    );
    return result.rows[0] ?? null;
  }
}
