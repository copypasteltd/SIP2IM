import { randomBytes, randomInt } from 'node:crypto';
import type pg from 'pg';
import { describe, expect, it } from 'vitest';
import { tokenHash } from '../src/auth/service.js';
import { BindingRepository, type BindV2Input } from '../src/devices/binding.js';
import { DeviceAdminRepository } from '../src/devices/admin-repo.js';
import { TransactionCommitUnknown, TransactionReleaseFailed } from '../src/db/pool.js';

const replayWindowMs = 24 * 60 * 60 * 1000;
const invalid = { error: 'BINDING_INVALID' };
const expired = { error: 'BINDING_EXPIRED' };
const digest = (value: unknown) => (value as Buffer).toString('hex');
const credential = () => randomBytes(32).toString('base64url');
const attempt = () => randomBytes(16).toString('base64url');
const current = () => randomInt(1_000_000).toString().padStart(6, '0');

function request(code: string): BindV2Input {
  return {
    protocolVersion: 2, attemptId: attempt(), code, manufacturer: 'Sample', model: 'Phone',
    apiLevel: 19, apkVersion: '1.0', apkCode: 1, locale: 'en',
  };
}

type Code = { expires_at: Date; used_at: Date | null; used_by_device: string | null };
type Control = {
  record_id: string; protocol_version: number | null; attempt_id: Buffer | null; credential_hash: Buffer | null;
  request_fingerprint: Buffer | null; replay_until: Date | null; cancelled_at: Date | null; teardown_pending: boolean;
};
type Device = { enabled: boolean; paused: boolean; revoked_at: Date | null; model: string };
type Credential = { device_id: string; revoked_at: Date | null };
type DbState = { codes: Map<string, Code>; controls: Map<string, Control>; devices: Map<string, Device>; credentials: Map<string, Credential> };
const copyMap = <T extends object>(entries: Map<string, T>) => new Map([...entries].map(([k, value]) => [k, { ...value }]));
const snapshot = (s: DbState): DbState => ({ codes: copyMap(s.codes), controls: copyMap(s.controls), devices: copyMap(s.devices), credentials: copyMap(s.credentials) });
const one = (row: object | undefined) => ({ rows: row ? [row] : [], rowCount: row ? 1 : 0 });
const changed = (rowCount = 1) => ({ rows: [], rowCount });

// The fake serializes active transactions and stages their writes. It checks
// the SQL boundary, but cannot establish PostgreSQL locking or durability.
function db() {
  let data: DbState = { codes: new Map(), controls: new Map(), devices: new Map(), credentials: new Map() };
  let now = Date.now();
  let queue = Promise.resolve();
  let failure: 'write' | 'commit' | 'release' | undefined;
  const histories: string[][] = [];
  const connection = () => {
    let draft: DbState | undefined;
    let releaseLock: (() => void) | undefined;
    let previous: Promise<void> | undefined;
    let fault: typeof failure;
    const history: string[] = [];
    histories.push(history);
    return {
      release() {
        releaseLock?.();
        if (fault === 'release') throw new Error('release acknowledgement lost');
      },
      async query(query: string, params: unknown[] = []) {
        const sql = query.replace(/\s+/g, ' ').trim();
        const [arg, second, third] = params;
        history.push(sql);
        if (sql === 'BEGIN') {
          previous = queue;
          queue = new Promise<void>(resolve => { releaseLock = resolve; });
          return changed(0);
        }
        if (sql.startsWith('SET ')) return changed(0);
        if (!draft) {
          await previous;
          draft = snapshot(data);
          fault = failure;
          failure = undefined;
        }
        if (sql === 'COMMIT') {
          data = draft;
          if (fault === 'commit') throw new Error('commit acknowledgement lost');
          return { ...changed(0), command: 'COMMIT' };
        }
        if (sql === 'ROLLBACK') return { ...changed(0), command: 'ROLLBACK' };
        const { codes, controls, devices, credentials } = draft;
        if (sql.startsWith('SELECT code_hash FROM binding_code WHERE used_by_device=')) {
          const rows = [...codes].filter(([, row]) => row.used_by_device === arg).map(([hash]) => hash).sort()
            .map(hash => ({ code_hash: Buffer.from(hash, 'hex') }));
          return { rows, rowCount: rows.length };
        }
        if (sql.startsWith('SELECT code_hash FROM binding_code_control WHERE record_id=')) {
          const hash = [...controls].find(([, value]) => value.record_id === arg)?.[0];
          return one(hash ? { code_hash: Buffer.from(hash, 'hex') } : undefined);
        }
        if (sql.startsWith('SELECT c.code_hash FROM binding_code c JOIN')) {
          const hash = [...controls].find(([, value]) => value.record_id === arg)?.[0];
          return one(hash && codes.has(hash) ? { code_hash: Buffer.from(hash, 'hex') } : undefined);
        }
        if (sql.startsWith('SELECT expires_at, used_at, used_by_device FROM binding_code WHERE')) {
          return one(codes.get(digest(arg)));
        }
        if (sql.startsWith('SELECT code_hash FROM binding_code WHERE code_hash=')) {
          return one(codes.has(digest(arg)) ? { code_hash: arg } : undefined);
        }
        if (sql.startsWith('SELECT cancelled_at, protocol_version,')) return one(controls.get(digest(arg)));
        if (sql.startsWith('SELECT 1 FROM binding_code WHERE')) {
          return changed(codes.get(digest(arg))!.expires_at.getTime() > now ? 1 : 0);
        }
        if (sql.startsWith('SELECT 1 FROM binding_code_control WHERE')) {
          return changed(controls.get(digest(arg))!.replay_until!.getTime() > now ? 1 : 0);
        }
        if (sql.startsWith('SELECT revoked_at FROM device WHERE')) return one(devices.get(String(arg)));
        if (sql.startsWith('SELECT revoked_at FROM device_credential WHERE')) {
          const row = credentials.get(digest(arg));
          return one(row?.device_id === second ? row : undefined);
        }
        if (sql.startsWith('SELECT token_hash FROM device_credential WHERE')) return changed(0);
        if (sql.startsWith('INSERT INTO device(')) {
          devices.set(String(arg), { enabled: true, paused: false, revoked_at: null, model: String(params[3]) });
          return changed();
        }
        if (sql.startsWith('INSERT INTO device_credential(')) {
          if (fault === 'write') throw new Error('injected write error');
          const hash = digest(arg);
          if (credentials.has(hash) && sql.includes('ON CONFLICT (token_hash) DO NOTHING')) return changed(0);
          if (credentials.has(hash)) throw new Error('credential unique violation');
          credentials.set(hash, { device_id: String(second), revoked_at: null });
          return changed();
        }
        if (sql.startsWith('UPDATE binding_code SET used_at=')) {
          const row = codes.get(digest(arg))!;
          if (sql.includes('AND expires_at') && row.expires_at.getTime() <= now) return changed(0);
          Object.assign(row, { used_at: new Date(now), used_by_device: second });
          return changed();
        }
        if (sql.startsWith('UPDATE binding_code_control AS control')) {
          const hash = digest(arg);
          Object.assign(controls.get(hash)!, {
            protocol_version: 2, attempt_id: second, credential_hash: third, request_fingerprint: params[3],
            replay_until: new Date(codes.get(hash)!.expires_at.getTime() + replayWindowMs),
          });
          return changed();
        }
        if (sql.startsWith('UPDATE device SET revoked_at=')) {
          const device = devices.get(String(arg));
          if (!device || device.revoked_at) return changed(0);
          device.revoked_at = new Date(now);
          return changed();
        }
        if (sql.startsWith('UPDATE device_credential SET revoked_at=')) {
          for (const row of credentials.values()) if (row.device_id === arg && !row.revoked_at) row.revoked_at = new Date(now);
          return changed();
        }
        if (sql.startsWith('UPDATE binding_code_control SET cancelled_at=')) {
          Object.assign(controls.get(digest(arg))!, { cancelled_at: new Date(now), teardown_pending: second });
          return changed();
        }
        if (sql.startsWith('UPDATE binding_code_control SET teardown_pending=false')) {
          const row = controls.get(digest(arg));
          if (!row?.cancelled_at) return changed(0);
          row.teardown_pending = false;
          return changed();
        }
        throw new Error('Unexpected binding SQL: ' + sql);
      },
    };
  };
  const pool = {
    connect: async () => connection(),
    async query(sql: string, [key]: Buffer[]) {
      if (!sql.includes('c.revoked_at IS NULL AND d.revoked_at IS NULL')) throw new Error('Unexpected binding pool query');
      const cred = data.credentials.get(digest(key));
      const device = cred && data.devices.get(cred.device_id);
      return one(cred && !cred.revoked_at && device && !device.revoked_at ? { id: cred.device_id, enabled: device.enabled } : undefined);
    },
  } as unknown as pg.Pool;
  return {
    pool, repo: new BindingRepository(pool), histories, data: () => data,
    at: (time: number) => { now = time; },
    fail: (mode: typeof failure) => { failure = mode; },
    issue(code: string, expiresAt = now + 60_000) {
      const hash = digest(tokenHash(code));
      const recordId = randomBytes(16).toString('hex');
      data.codes.set(hash, { expires_at: new Date(expiresAt), used_at: null, used_by_device: null });
      data.controls.set(hash, { record_id: recordId, protocol_version: null, attempt_id: null,
        credential_hash: null, request_fingerprint: null, replay_until: null, cancelled_at: null, teardown_pending: false });
      return { hash, recordId, expiresAt };
    },
  };
}

function successful(result: Awaited<ReturnType<BindingRepository['bindV2']>>) {
  if ('error' in result) throw new Error('Expected binding success');
  return result;
}

function setup() {
  const fake = db();
  const code = current();
  const issued = fake.issue(code);
  const bearer = credential();
  return { ...fake, ...issued, input: request(code), bearer, key: tokenHash(bearer) };
}

describe('retry-safe binding transaction', () => {
  it('serializes parallel exact requests and preserves the first identity and metadata', async () => {
    const f = setup();
    const [first, replay, reordered] = await Promise.all([
      f.repo.bindV2(f.input, f.key), f.repo.bindV2(f.input, f.key),
      f.repo.bindV2({ locale: f.input.locale, ...Object.fromEntries(Object.entries(f.input).reverse()) } as BindV2Input, f.key),
    ]);
    const accepted = successful(first);
    expect(replay).toEqual(accepted);
    expect(reordered).toEqual(accepted);
    expect(Object.keys(accepted).sort()).toEqual(['attemptId', 'deviceId', 'protocolVersion']);
    expect(f.data().devices.size).toBe(1);
    expect(f.data().credentials.size).toBe(1);
    expect(await f.repo.authenticate(f.bearer)).toEqual({ id: accepted.deviceId, enabled: true });
    await expect(f.repo.bindV2({ ...f.input, model: 'different' }, f.key)).resolves.toEqual(invalid);
    await expect(f.repo.bindV2({ ...f.input, attemptId: attempt() }, f.key)).resolves.toEqual(invalid);
    await expect(f.repo.bindV2(f.input, tokenHash(credential()))).resolves.toEqual(invalid);
    expect(f.data().devices.get(accepted.deviceId)?.model).toBe(f.input.model);
  });

  it('retains the replay window after code expiry and does not re-enable a device', async () => {
    const f = setup();
    const accepted = successful(await f.repo.bindV2(f.input, f.key));
    Object.assign(f.data().devices.get(accepted.deviceId)!, { enabled: false, paused: true });
    f.at(f.expiresAt + replayWindowMs - 1);
    await expect(f.repo.bindV2(f.input, f.key)).resolves.toEqual(accepted);
    expect(f.data().devices.get(accepted.deviceId)).toMatchObject({ enabled: false, paused: true });
    f.at(f.expiresAt + replayWindowMs);
    await expect(f.repo.bindV2(f.input, f.key)).resolves.toEqual(invalid);
  });

  it('commits one winner for a competing key and rolls back a credential collision on another code', async () => {
    const f = setup();
    const [a, b] = await Promise.all([f.repo.bindV2(f.input, f.key), f.repo.bindV2(f.input, tokenHash(credential()))]);
    expect('error' in a).toBe(false);
    expect(b).toEqual(invalid);
    const otherCode = String((Number(f.input.code) + 1) % 1_000_000).padStart(6, '0');
    const other = f.issue(otherCode);
    await expect(f.repo.bindV2(request(otherCode), f.key)).resolves.toEqual(invalid);
    expect(f.data().codes.get(other.hash)?.used_at).toBeNull();
    expect(f.data().devices.size).toBe(1);
    expect('error' in await f.repo.bindV2(request(otherCode), tokenHash(credential()))).toBe(false);
  });

  it('honors unused expiry and keeps legacy bindings v1-only', async () => {
    const f = setup();
    const legacy = await f.repo.bind(f.input);
    if ('error' in legacy) throw new Error('Expected legacy success');
    expect(legacy.token).toHaveLength(43);
    await expect(f.repo.bindV2(f.input, tokenHash(legacy.token))).resolves.toEqual(invalid);
    const otherCode = String((Number(f.input.code) + 1) % 1_000_000).padStart(6, '0');
    const other = f.issue(otherCode);
    f.at(other.expiresAt);
    await expect(f.repo.bindV2(request(otherCode), f.key)).resolves.toEqual(expired);
    expect(f.data().devices.size).toBe(1);
  });

  it.each(['commit', 'release'] as const)('replays the committed identity after %s uncertainty', async fault => {
    const f = setup();
    f.fail(fault);
    await expect(f.repo.bindV2(f.input, f.key)).rejects.toBeInstanceOf(fault === 'commit' ? TransactionCommitUnknown : TransactionReleaseFailed);
    const deviceId = f.data().codes.get(f.hash)?.used_by_device;
    expect(deviceId).toBeTruthy();
    await expect(f.repo.bindV2(f.input, f.key)).resolves.toEqual({ protocolVersion: 2, attemptId: f.input.attemptId, deviceId });
    expect(f.data().devices.size).toBe(1);
  });

  it('leaves the same request retryable after a confirmed write rollback', async () => {
    const f = setup();
    f.fail('write');
    await expect(f.repo.bindV2(f.input, f.key)).rejects.toThrow('injected write error');
    expect(f.data().devices.size).toBe(0);
    expect(f.data().codes.get(f.hash)?.used_at).toBeNull();
    expect('error' in await f.repo.bindV2(f.input, f.key)).toBe(false);
  });

  it('blocks replay after ordinary revocation and locks code, device and credential in order', async () => {
    const f = setup();
    const { deviceId } = successful(await f.repo.bindV2(f.input, f.key));
    const revoke = new DeviceAdminRepository(f.pool).revoke(deviceId);
    const replay = f.repo.bindV2(f.input, f.key);
    await expect(revoke).resolves.toBe(true);
    await expect(replay).resolves.toEqual(invalid);
    await expect(f.repo.authenticate(f.bearer)).resolves.toBeNull();
    const locks = f.histories[1]!.filter(sql => sql.includes('FOR UPDATE'));
    expect(locks.map(sql => sql.split(' FROM ')[1]?.split(' ')[0])).toEqual(['binding_code', 'device', 'device_credential']);
    expect(locks.at(-1)).toContain('ORDER BY token_hash');
  });
});

describe('binding cancellation', () => {
  it('durably fences an unused record before either binding protocol can consume it', async () => {
    const f = setup();
    const cancellation = f.repo.cancelCode(f.recordId);
    const lateV2 = f.repo.bindV2(f.input, f.key);
    const lateV1 = f.repo.bind(f.input);
    await expect(cancellation).resolves.toEqual({ deviceId: null, teardownPending: false });
    await expect(lateV2).resolves.toEqual(invalid);
    await expect(lateV1).resolves.toEqual(invalid);
    expect(f.data().devices.size).toBe(0);
  });

  it('revokes a concurrent winner, retains cancellation across a lost COMMIT reply, and tracks teardown', async () => {
    const f = setup();
    const bind = f.repo.bindV2(f.input, f.key);
    const cancellation = f.repo.cancelCode(f.recordId);
    const { deviceId } = successful(await bind);
    await expect(cancellation).resolves.toEqual({ deviceId, teardownPending: true });
    await expect(f.repo.authenticate(f.bearer)).resolves.toBeNull();
    await expect(f.repo.bindV2(f.input, f.key)).resolves.toEqual(invalid);
    await expect(f.repo.bind(f.input)).resolves.toEqual(invalid);
    const locks = f.histories[1]!.filter(sql => sql.includes('FOR UPDATE'));
    expect(locks.map(sql => sql.split(' FROM ')[1]?.split(' ')[0])).toEqual(['binding_code', 'device', 'device_credential']);
    f.fail('commit');
    await expect(f.repo.markTeardownComplete(f.recordId)).rejects.toBeInstanceOf(TransactionCommitUnknown);
    await expect(f.repo.cancelCode(f.recordId)).resolves.toEqual({ deviceId, teardownPending: false });
  });

  it('recovers the same fence when the cancellation acknowledgement is lost', async () => {
    const f = setup();
    const { deviceId } = successful(await f.repo.bindV2(f.input, f.key));
    f.fail('commit');
    await expect(f.repo.cancelCode(f.recordId)).rejects.toBeInstanceOf(TransactionCommitUnknown);
    await expect(f.repo.cancelCode(f.recordId)).resolves.toEqual({ deviceId, teardownPending: true });
    await f.repo.markTeardownComplete(f.recordId);
    await expect(f.repo.cancelCode(f.recordId)).resolves.toEqual({ deviceId, teardownPending: false });
    await expect(f.repo.bindV2(f.input, f.key)).resolves.toEqual(invalid);
  });
});
