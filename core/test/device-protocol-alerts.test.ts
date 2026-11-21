import type pg from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { tokenHash } from '../src/auth/service.js';
import { DeviceProtocolAlerts, type DeviceProtocolObservation } from '../src/devices/protocol-alerts.js';
import { DeviceCommands } from '../src/ws-device/commands.js';
import { DeviceSessions, type DeviceSessionDeps } from '../src/ws-device/session.js';

const deviceId = 'dev_01ARZ3NDEKTSV4RRFFQ69G5FAV';
const token = 'fixture-device-credential';
const envelope = { v: 1, type: 'hello', id: 'evt_01ARZ3NDEKTSV4RRFFQ69G5FAV', ts: 1 };
const compatible = JSON.stringify({ ...envelope, payload: { token, protocol: 1,
  apkVersion: 'fixture-version', apkCode: 1, manufacturer: 'fixture', model: 'fixture', apiLevel: 19, locale: 'en' } });
// Optional metadata from another major does not have to match the supported hello payload.
const mismatch = JSON.stringify({ ...envelope, payload: { token, protocol: 2, apkCode: 'different shape' } });
const heartbeat = JSON.stringify({ ...envelope, type: 'heartbeat', payload: {
  battery: null, charging: null, network: 'wifi', signalDbm: null, shizuku: 'running', paused: false,
} });
const accepted = { id: deviceId, enabled: true };
const socket = () => ({ send: vi.fn(), close: vi.fn(), readyState: 1 });
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }

function sessions(overrides: Partial<DeviceSessionDeps> = {}) {
  const authenticate = vi.fn(async (_token: string) => accepted);
  const observe = vi.fn(async (_observation: DeviceProtocolObservation) => {});
  const currentConfig = vi.fn(async () => ({ heartbeatSec: 30, locale: 'en' }));
  const commands = new DeviceCommands();
  const sessions = new DeviceSessions({ authenticate, heartbeat: async () => {}, onEvent: async () => true,
    heartbeatSec: 30, locale: 'en', currentConfig, commands, protocolAlerts: { observe }, ...overrides });
  return { sessions, authenticate, observe, currentConfig, commands };
}

describe('device session protocol evidence', () => {
  it('sends 4005 without waiting for authentication and searches only the supplied credential', async () => {
    const authority = deferred<typeof accepted>();
    const ws = socket();
    const authenticate = vi.fn(async (_token: string) => {
      expect(ws.close).toHaveBeenCalledWith(4005);
      return authority.promise;
    });
    const f = sessions({ authenticate });
    const work = f.sessions.open(ws).message(mismatch);
    await tick();
    expect(ws.close).toHaveBeenCalledExactlyOnceWith(4005);
    expect(f.observe).not.toHaveBeenCalled();
    authority.resolve(accepted);
    await work;
    expect(authenticate).toHaveBeenCalledExactlyOnceWith(token);
    expect(f.observe).toHaveBeenCalledExactlyOnceWith({ kind: 'mismatch', deviceId,
      credentialHash: tokenHash(token), isCurrent: expect.any(Function) });
    expect(ws.send).not.toHaveBeenCalled();
    expect(f.currentConfig).not.toHaveBeenCalled();
    expect(f.commands.isConnected(deviceId)).toBe(false);
    await f.sessions.stop();
  });

  it('keeps baseline close codes but never authenticates unconfirmed mismatch evidence', async () => {
    const f = sessions();
    const invalid: unknown[] = [null, {}, { ...envelope, v: 2, payload: { token, protocol: 2 } },
      { ...envelope, ts: -1, payload: { token, protocol: 2 } },
      { ...envelope, id: 'invalid', payload: { token, protocol: 2 } },
      { ...envelope, type: 'heartbeat', payload: { token, protocol: 2 } },
      ...[undefined, null, '2', 1.5, -1, Number.MAX_SAFE_INTEGER + 1].map(protocol => ({ ...envelope, payload: { token, protocol } })),
      ...[undefined, null, '', 1].map(token => ({ ...envelope, payload: { token, protocol: 2 } }))];
    for (const input of invalid) {
      const ws = socket();
      await f.sessions.open(ws).message(JSON.stringify(input));
      expect(ws.close).toHaveBeenCalledExactlyOnceWith(4005);
    }
    for (const raw of ['{', JSON.stringify({ ...envelope, payload: { token, protocol: 1 } })]) {
      const ws = socket();
      await f.sessions.open(ws).message(raw);
      expect(ws.close).toHaveBeenCalledExactlyOnceWith(4003);
    }
    expect(f.authenticate).not.toHaveBeenCalled();
    expect(f.observe).not.toHaveBeenCalled();
    await f.sessions.stop();
  });

  it.each([null, { ...accepted, enabled: false }, new Error('fixture authority unavailable')])(
    'does not observe when authentication is not confirmed: %j', async (result) => {
      const f = sessions({ authenticate: async () => { if (result instanceof Error) throw result; return result; } });
      const ws = socket();
      await f.sessions.open(ws).message(mismatch);
      expect(ws.close).toHaveBeenCalledExactlyOnceWith(4005);
      expect(f.observe).not.toHaveBeenCalled();
      await f.sessions.stop();
    });

  it('drops old mismatch authentication finishing after a compatible hello, even if the latter detached', async () => {
    const authority = deferred<typeof accepted>();
    const authenticate = vi.fn().mockReturnValueOnce(authority.promise).mockResolvedValue(accepted);
    const f = sessions({ authenticate });
    const a = socket(), b = socket();
    const old = f.sessions.open(a).message(mismatch);
    await tick();
    const recovery = f.sessions.open(b);
    await recovery.message(compatible);
    await vi.waitFor(() => expect(f.observe).toHaveBeenCalledOnce());
    expect(f.observe.mock.calls[0]?.[0].kind).toBe('compatible');
    recovery.close();
    authority.resolve(accepted);
    await old;
    expect(f.observe).toHaveBeenCalledOnce();
    expect(a.close).toHaveBeenCalledExactlyOnceWith(4005);
    await f.sessions.stop();
  });

  it('does not let observation-only authentication replace or supersede an eligible hello', async () => {
    const config = deferred<{ heartbeatSec: number; locale: string }>();
    const f = sessions({ currentConfig: () => config.promise });
    const a = socket(), b = socket();
    const joining = f.sessions.open(a).message(compatible);
    await tick();
    await f.sessions.open(b).message(mismatch);
    expect(b.close).toHaveBeenCalledWith(4005);
    expect(a.close).not.toHaveBeenCalled();
    config.resolve({ heartbeatSec: 31, locale: 'en' });
    await joining;
    await vi.waitFor(() => expect(f.observe).toHaveBeenCalledTimes(2));
    expect(f.observe.mock.calls.map(([input]) => input.kind)).toEqual(['mismatch', 'compatible']);
    expect(JSON.parse(a.send.mock.calls[0]![0])).toMatchObject({ type: 'hello.ok', payload: {
      deviceId, config: { heartbeatSec: 31, locale: 'en' },
    } });
    await f.sessions.stop();
  });

  it('does not reopen an episode when an earlier hello confirms after rejection but before mismatch auth settles', async () => {
    const config = deferred<{ heartbeatSec: number; locale: string }>();
    const authority = deferred<typeof accepted>();
    const authenticate = vi.fn().mockResolvedValueOnce(accepted).mockReturnValueOnce(authority.promise);
    const f = sessions({ authenticate, currentConfig: () => config.promise });
    const a = socket(), b = socket();
    const joining = f.sessions.open(a).message(compatible);
    await tick();
    const rejection = f.sessions.open(b).message(mismatch);
    await tick();
    expect(b.close).toHaveBeenCalledExactlyOnceWith(4005);
    config.resolve({ heartbeatSec: 30, locale: 'en' });
    await joining;
    authority.resolve(accepted);
    await rejection;
    expect(f.observe.mock.calls.map(([input]) => input.kind)).toEqual(['compatible']);
    await f.sessions.stop();
  });

  it('does not treat mere compatible authentication as a successful attachment', async () => {
    const authority = deferred<typeof accepted>();
    const authenticate = vi.fn().mockReturnValueOnce(authority.promise).mockResolvedValue(accepted);
    const f = sessions({ authenticate, currentConfig: async () => { throw new Error('config unavailable'); } });
    const a = socket(), b = socket();
    const rejected = f.sessions.open(a).message(mismatch);
    await tick();
    await f.sessions.open(b).message(compatible);
    expect(b.close).toHaveBeenCalledExactlyOnceWith(1011);
    expect(b.send).not.toHaveBeenCalled();
    authority.resolve(accepted);
    await rejected;
    expect(f.observe.mock.calls.map(([input]) => input.kind)).toEqual(['mismatch']);
    await f.sessions.stop();
  });

  it('preserves the authentication wait deadline without treating expiry as recovery', async () => {
    vi.useFakeTimers();
    const authority = deferred<typeof accepted>();
    const f = sessions({ authenticate: () => authority.promise });
    try {
      const ws = socket();
      const hello = f.sessions.open(ws).message(compatible);
      await vi.advanceTimersByTimeAsync(4999);
      expect(ws.close).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(ws.close).toHaveBeenCalledExactlyOnceWith(4001);
      authority.resolve(accepted);
      await hello;
      expect(ws.send).not.toHaveBeenCalled();
      expect(f.observe).not.toHaveBeenCalled();
    } finally { authority.resolve(accepted); await f.sessions.stop(); vi.useRealTimers(); }
  });

  it('drops an incompatible auth result superseded by explicit revocation', async () => {
    const authority = deferred<typeof accepted>();
    const f = sessions({ authenticate: () => authority.promise });
    const ws = socket();
    const work = f.sessions.open(ws).message(mismatch);
    await tick();
    f.sessions.revoke(deviceId);
    authority.resolve(accepted);
    await work;
    expect(ws.close).toHaveBeenCalledExactlyOnceWith(4005);
    expect(f.observe).not.toHaveBeenCalled();
    await f.sessions.stop();
  });

  it('bounds pending mismatch authentication and discards expired observations', async () => {
    const authority = deferred<typeof accepted>();
    const auth = vi.fn(() => authority.promise);
    const time = vi.spyOn(performance, 'now').mockReturnValue(10);
    const f = sessions({ authenticate: auth });
    try {
      const sockets = Array.from({ length: 8 }, socket);
      const checks = sockets.map(ws => f.sessions.open(ws).message(mismatch));
      await tick();
      expect(auth).toHaveBeenCalledTimes(2);
      for (const ws of sockets) expect(ws.close).toHaveBeenCalledExactlyOnceWith(4005);
      time.mockReturnValue(5010);
      authority.resolve(accepted);
      await Promise.all(checks);
      expect(f.observe).not.toHaveBeenCalled();
    } finally { time.mockRestore(); authority.resolve(accepted); await f.sessions.stop(); }
  });

  it('keeps compatible admission and heartbeat independent of a blocked observer and fences replacement', async () => {
    const release = deferred<void>();
    const outcomes: boolean[] = [];
    const observe = vi.fn(async (input: DeviceProtocolObservation) => {
      if (observe.mock.calls.length === 1) await release.promise;
      outcomes.push(input.isCurrent());
    });
    const beat = vi.fn(async () => {});
    const f = sessions({ protocolAlerts: { observe }, heartbeat: beat });
    const a = socket(), b = socket(), sa = f.sessions.open(a), sb = f.sessions.open(b);
    try {
      await sa.message(compatible);
      expect(a.send).toHaveBeenCalledOnce();
      await vi.waitFor(() => expect(observe).toHaveBeenCalledOnce());
      await sb.message(compatible);
      await sb.message(heartbeat);
      expect(a.close).toHaveBeenCalledExactlyOnceWith(4009);
      expect(b.send).toHaveBeenCalledOnce();
      expect(beat).toHaveBeenCalledOnce();
      expect(observe.mock.calls[0]![0].isCurrent()).toBe(false);
      release.resolve();
      await vi.waitFor(() => expect(outcomes).toEqual([false, true]));
    } finally { release.resolve(); await f.sessions.stop(); }
  });

  it.each(['closed in send', 'transport closing', 'throwing send'])('never reports compatible recovery for %s', async reason => {
    const f = sessions();
    const ws = socket();
    const session = f.sessions.open(ws);
    if (reason === 'closed in send') ws.send.mockImplementation(() => session.close());
    if (reason === 'transport closing') ws.readyState = 2;
    if (reason === 'throwing send') ws.send.mockImplementation(() => { throw new Error('fixture send failure'); });
    await session.message(compatible);
    await tick();
    expect(f.observe).not.toHaveBeenCalled();
    if (reason === 'throwing send') expect(ws.close).toHaveBeenCalledWith(1011);
    await f.sessions.stop();
  });
});

interface Episode { id: string; state: 'open' | 'acked' | 'resolved'; resolvedAt: number | null }
function repository() {
  const row = (rows: unknown[] = [], command = 'SELECT') => ({ rows, rowCount: rows.length, command });
  const authority = { enabled: true, deviceRevoked: false, credentialRevoked: false, owner: deviceId };
  const flags = { current: true, owner: true, committed: false, loseCommit: false };
  const episodes: Episode[] = [];
  const steps: string[] = [];
  let saved: Episode[] = [];
  let afterWrite: () => void = () => {};
  let pauseBeforeDeviceLock: () => Promise<void> = async () => {};
  const query = vi.fn(async (sql: string, args: unknown[] = []) => {
    if (sql === 'BEGIN') { flags.committed = false; saved = episodes.map(item => ({ ...item })); steps.push(sql); return row([], sql); }
    if (sql === 'COMMIT') {
      steps.push(sql);
      if (flags.loseCommit) throw new Error('fixture lost commit reply');
      flags.committed = true;
      return row([], sql);
    }
    if (sql === 'ROLLBACK') { episodes.splice(0, episodes.length, ...saved); steps.push(sql); return row([], sql); }
    if (sql.startsWith('SET LOCAL lock_timeout')) { steps.push('timeout'); return row(); }
    if (sql.includes('FROM device WHERE')) {
      await pauseBeforeDeviceLock();
      expect(sql).toContain('enabled=true AND revoked_at IS NULL FOR UPDATE');
      expect(args).toEqual([deviceId]);
      steps.push('device lock');
      return row(authority.enabled && !authority.deviceRevoked ? [{ id: deviceId }] : []);
    }
    if (sql.includes('FROM device_credential WHERE')) {
      expect(steps.at(-1)).toBe('device lock');
      expect(sql).toContain('device_id=$1 AND token_hash=$2 AND revoked_at IS NULL FOR UPDATE');
      expect(args).toEqual([deviceId, tokenHash(token)]);
      steps.push('credential lock');
      return row(authority.owner === deviceId && !authority.credentialRevoked ? [{}] : []);
    }
    expect(steps.at(-1)).toBe('credential lock');
    expect(args.slice(0, 3)).toEqual(['protocol_mismatch', 'device', deviceId]);
    const active = episodes.find(item => !item.resolvedAt);
    let changed: Episode | undefined;
    if (sql.startsWith('INSERT INTO alert(')) {
      steps.push('raise');
      expect(args).toEqual(['protocol_mismatch', 'device', deviceId, expect.stringMatching(/^alr_/), false]);
      expect(sql).toContain("state IN ('open','acked') AND resolved_at IS NULL");
      if (!active) { changed = { id: args[3] as string, state: 'open', resolvedAt: null }; episodes.push(changed); }
    } else if (sql.startsWith('UPDATE alert SET')) {
      steps.push('resolve');
      expect(args).toHaveLength(3);
      expect(sql).toContain("CASE WHEN state='open' THEN 'resolved' ELSE state END");
      if (active) {
        if (active.state === 'open') active.state = 'resolved';
        active.resolvedAt = 2;
        changed = active;
      }
    } else throw new Error('Unexpected fixture query');
    afterWrite();
    return row(changed ? [{ ...changed, type: 'protocol_mismatch', subjectType: 'device', subjectId: deviceId, detail: {} }] : []);
  });
  const release = vi.fn();
  const connect = vi.fn(async () => ({ query, release }));
  const publish = vi.fn(async (_type: unknown, _data: unknown) => {
    expect(flags.committed).toBe(true);
    steps.push('publish');
  });
  const assertAdmission = vi.fn(() => { if (!flags.owner) throw new Error('fixture ownership lost'); });
  const repo = new DeviceProtocolAlerts({ connect } as unknown as pg.Pool, assertAdmission, publish);
  const observe = (kind: DeviceProtocolObservation['kind']) => repo.observe({ kind, deviceId, credentialHash: tokenHash(token), isCurrent: () => flags.current });
  return { repo, observe, authority, flags, query, publish, connect, episodes, steps, release, assertAdmission,
    afterWrite: (fn: () => void) => { afterWrite = fn; },
    beforeDeviceLock: (fn: () => Promise<void>) => { pauseBeforeDeviceLock = fn; } };
}

describe('protocol alert persistence', () => {
  it('raises once per unresolved episode, recovers an acknowledged row, and publishes only committed changes', async () => {
    const f = repository();
    await f.observe('mismatch');
    expect(f.steps).toEqual(['BEGIN', 'timeout', 'device lock', 'credential lock', 'raise', 'COMMIT', 'publish']);
    await f.observe('mismatch');
    f.episodes[0]!.state = 'acked';
    await f.observe('mismatch');
    expect(f.episodes).toHaveLength(1);
    expect(f.publish).toHaveBeenCalledOnce();
    await f.observe('compatible');
    await f.observe('compatible');
    expect(f.episodes[0]).toMatchObject({ state: 'acked', resolvedAt: 2 });
    await f.observe('mismatch');
    expect(f.episodes).toHaveLength(2);
    expect(f.publish.mock.calls.map(([type]) => type)).toEqual(['alert.raised', 'alert.resolved', 'alert.raised']);
    expect(f.publish.mock.calls[0]?.[1]).toMatchObject({ subjectId: deviceId, detail: {} });
    expect(JSON.stringify(f.publish.mock.calls)).not.toContain(token);
  });

  it('does not persist stale recovery during replacement but recovers from a subsequent live handshake', async () => {
    const db = repository();
    const f = sessions({ protocolAlerts: db.repo });
    const lockEntered = deferred<void>(), releaseLock = deferred<void>();
    try {
      await f.sessions.open(socket()).message(mismatch);
      expect(db.episodes[0]?.state).toBe('open');
      db.beforeDeviceLock(async () => { lockEntered.resolve(); await releaseLock.promise; });
      const a = socket(), b = socket();
      const old = f.sessions.open(a), replacement = f.sessions.open(b);
      await old.message(compatible);
      await lockEntered.promise;
      await replacement.message(compatible);
      expect(a.close).toHaveBeenCalledExactlyOnceWith(4009);
      expect(b.send).toHaveBeenCalledOnce();
      replacement.close();
      releaseLock.resolve();
      await vi.waitFor(() => expect(db.release).toHaveBeenCalledTimes(2));
      expect(db.episodes[0]?.state).toBe('open');
      expect(db.steps).not.toContain('resolve');
      expect(db.publish).toHaveBeenCalledOnce();
      await f.sessions.open(socket()).message(compatible);
      await vi.waitFor(() => expect(db.episodes[0]?.state).toBe('resolved'));
      await vi.waitFor(() => expect(db.publish).toHaveBeenCalledTimes(2));
    } finally { releaseLock.resolve(); await f.sessions.stop(); }
  });

  it.each(['disabled device', 'revoked device', 'revoked credential', 'wrong credential owner', 'stale attachment'])(
    'rechecks %s after waiting for the device lock', async (caseName) => {
      const f = repository();
      const entered = deferred<void>(), resume = deferred<void>();
      f.beforeDeviceLock(async () => { entered.resolve(); await resume.promise; });
      const work = f.observe('compatible');
      await entered.promise;
      if (caseName === 'disabled device') f.authority.enabled = false;
      if (caseName === 'revoked device') f.authority.deviceRevoked = true;
      if (caseName === 'revoked credential') f.authority.credentialRevoked = true;
      if (caseName === 'wrong credential owner') f.authority.owner = 'another-device';
      if (caseName === 'stale attachment') f.flags.current = false;
      resume.resolve();
      await work;
      expect(f.steps).not.toContain('resolve');
      expect(f.publish).not.toHaveBeenCalled();
    });

  it.each(['stale attachment', 'lost ownership'])('rolls back rather than publishing if %s changes during a write', async reason => {
    const f = repository();
    f.afterWrite(() => { if (reason === 'stale attachment') f.flags.current = false; else f.flags.owner = false; });
    await expect(f.observe('mismatch')).rejects.toThrow();
    expect(f.steps.at(-1)).toBe('ROLLBACK');
    expect(f.steps).not.toContain('COMMIT');
    expect(f.episodes).toHaveLength(0);
    expect(f.publish).not.toHaveBeenCalled();
  });

  it('does not publish or retry on unconfirmed commit', async () => {
    const f = repository();
    f.flags.loseCommit = true;
    await expect(f.observe('mismatch')).rejects.toMatchObject({ name: 'TransactionCommitUnknown' });
    expect(f.publish).not.toHaveBeenCalled();
    expect(f.connect).toHaveBeenCalledOnce();
    expect(f.release).toHaveBeenCalledExactlyOnceWith(true);
  });
});
