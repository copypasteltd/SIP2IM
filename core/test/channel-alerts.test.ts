import { adminAlert } from '@voipgw/protocol';
import type pg from 'pg';
import { expect, it, vi } from 'vitest';
import { ChannelRepository } from '../src/channels/repo.js';
import { TransactionCommitUnknown, TransactionReleaseFailed, TransactionRolledBack } from '../src/db/pool.js';

interface Alert {
  id: string;
  type: string;
  subjectType: string;
  subjectId: string;
  state: 'open' | 'acked' | 'resolved';
  severity: 'warning';
  detail: Record<string, never>;
  firstAt: number;
  lastAt: number;
  pushedAt: null;
  resolvedAt: number | null;
}
const report = (state: string, selfId: string | null = null, alias: string | null = null) => ({ state, selfId, alias });
const marker = '_voipgwObservedLogin';
const capabilities = (login: boolean) => ({
  login, sendMessage: false, receiveMessage: false, dial: false,
  receiveAudio: false, sendAudio: false, maxConcurrentCalls: 0,
});
const isolation = 'SET TRANSACTION ISOLATION LEVEL READ COMMITTED';
const durability = 'SET LOCAL synchronous_commit = on';
const setup = ['BEGIN', isolation, durability];
const rowLock = "SELECT state, capabilities->'_voipgwObservedLogin'='true'::jsonb AS armed FROM channel WHERE platform=$1 FOR UPDATE";
const stateWrite = 'UPDATE channel SET state=';
const capabilityWrite = 'UPDATE channel SET capabilities=';
const raise = 'INSERT INTO alert(';
const resolve = 'UPDATE alert SET state=';
const incident = (id: string): Alert => ({ id, type: 'channel_down', subjectType: 'channel', subjectId: 'qq',
  severity: 'warning', state: 'open', detail: {}, firstAt: 1, lastAt: 1, pushedAt: null, resolvedAt: null });
const queryResult = (rows: unknown[] = [], rowCount = rows.length, command = 'SELECT') => ({ rows, rowCount, command });
const json = (value: unknown): Record<string, unknown> => JSON.parse(String(value));

function fixture(state = 'logged_out', armed = false) {
  type Row = ReturnType<typeof report> & { capabilities: Record<string, unknown> };
  type Data = { row: Row; alerts: Alert[] };
  let committed: Data = {
    row: { ...report(state, 'fixture-account', 'Fixture alias'), capabilities: { login: true, ...(armed ? { [marker]: true } : {}) } },
    alerts: [],
  };
  let draft: Data | undefined;
  let locked = false;
  let commitTag = 'COMMIT';
  const before = new Map<string, () => void | Promise<void>>();
  const after = new Map<string, () => void | Promise<void>>();
  const runHook = (hooks: typeof before, sql: string) => [...hooks].find(([prefix]) => sql.startsWith(prefix))?.[1]();
  const release = vi.fn((_discard?: boolean) => {});

  function execute(sql: string, params: unknown[]) {
    if (sql === 'BEGIN') {
      expect(draft).toBeUndefined();
      locked = false;
      draft = structuredClone(committed);
      return queryResult([], 0, sql);
    }
    if (sql === 'ROLLBACK') {
      draft = undefined;
      return queryResult([], 0, sql);
    }
    if (!draft) throw new Error('Query outside a transaction: ' + sql);
    if (sql === 'COMMIT') {
      if (commitTag === 'COMMIT') committed = draft;
      draft = undefined;
      return queryResult([], 0, commitTag);
    }
    if (sql === isolation || sql === durability) return queryResult([], 0, 'SET');
    if (sql === rowLock) {
      expect(params).toEqual(['qq']);
      locked = true;
      return queryResult([{ state: draft.row.state, armed: draft.row.capabilities[marker] === true }]);
    }
    expect(locked).toBe(true);
    if (sql.startsWith(stateWrite)) {
      expect(sql).toContain('self_id=CASE WHEN $3::boolean THEN $4::text ELSE self_id END');
      expect(sql).toContain('alias=CASE WHEN $3::boolean THEN $5::text ELSE alias END');
      expect(sql).toContain('WHEN $7::jsonb IS NOT NULL THEN $7::jsonb');
      expect(sql).toContain("WHEN $3::boolean THEN capabilities-'_voipgwObservedLogin' ELSE '{}'::jsonb END");
      expect(sql).toContain(`(CASE WHEN $6::boolean THEN '{"_voipgwObservedLogin":true}'::jsonb ELSE '{}'::jsonb END)`);
      expect(sql).toContain('WHERE platform=$1');
      const [platform, next, hasReport, selfId, alias, nextArmed, initial] = params;
      expect(platform).toBe('qq');
      draft.row.state = String(next);
      if (hasReport) {
        draft.row.selfId = selfId as string | null;
        draft.row.alias = alias as string | null;
      }
      if (initial !== null) draft.row.capabilities = json(initial);
      else if (!hasReport) draft.row.capabilities = {};
      delete draft.row.capabilities[marker];
      if (nextArmed) draft.row.capabilities[marker] = true;
      return queryResult([], 1, 'UPDATE');
    }
    if (sql.startsWith(capabilityWrite)) {
      expect(sql).toContain('capabilities=$2::jsonb ||');
      expect(sql).toContain(`(CASE WHEN $3::boolean THEN '{"_voipgwObservedLogin":true}'::jsonb ELSE '{}'::jsonb END)`);
      expect(sql).toContain('WHERE platform=$1');
      expect(params[0]).toBe('qq');
      draft.row.capabilities = { ...json(params[1]), ...(params[2] === true ? { [marker]: true } : {}) };
      return queryResult([], 1, 'UPDATE');
    }
    if (sql.startsWith(resolve)) {
      expect(params).toEqual(['channel_down', 'channel', 'qq']);
      const open = draft.alerts.find(alert => alert.resolvedAt === null);
      if (!open) return queryResult();
      if (open.state === 'open') open.state = 'resolved';
      open.resolvedAt = 2;
      return queryResult([{ ...open }], 1, 'UPDATE');
    }
    if (sql.startsWith(raise)) {
      expect(params.slice(0, 3)).toEqual(['channel_down', 'channel', 'qq']);
      expect(params[4]).toBe(false);
      expect(sql).toContain("state IN ('open','acked') AND resolved_at IS NULL");
      expect(sql).toContain("ON CONFLICT (type,subject_id) WHERE state='open' DO NOTHING");
      if (draft.alerts.some(alert => alert.resolvedAt === null)) return queryResult();
      const alert = incident(String(params[3]));
      draft.alerts.push(alert);
      return queryResult([{ ...alert }], 1, 'INSERT');
    }
    throw new Error('Unexpected query: ' + sql);
  }
  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    await runHook(before, sql);
    const result = execute(sql, params);
    await runHook(after, sql);
    return result;
  });
  const connect = vi.fn(async () => ({ query, release }));
  const poolQuery = vi.fn(async (sql: string, params: unknown[]) => {
    expect(sql).toContain("$1::jsonb || jsonb_build_object('login',COALESCE(c.capabilities->'login'='true'::jsonb,false))");
    expect(json(params[0])).toEqual(capabilities(false));
    return queryResult([{ platform: 'qq', ...committed.row,
      capabilities: { ...json(params[0]), login: committed.row.capabilities.login === true } }]);
  });
  const pool = { query: poolQuery, connect } as unknown as pg.Pool;
  return {
    repo: new ChannelRepository(pool), connect, release, query, poolQuery,
    get row() { return committed.row; },
    get alerts() { return committed.alerts; },
    get armed() { return committed.row.capabilities[marker] === true; },
    steps: () => query.mock.calls.map(([sql]) => [stateWrite, capabilityWrite, raise, resolve].find(prefix => sql.startsWith(prefix)) ?? sql),
    before, after,
    commitReturns(tag: string) { commitTag = tag; },
  };
}

function gate() {
  let open!: () => void;
  const wait = new Promise<void>(resolveGate => { open = resolveGate; });
  return { open, wait };
}

it('does not alert on a never-logged-in channel or an attachment reset alone', async () => {
  const f = fixture();
  expect(await f.repo.adapterOffline('qq')).toBeNull();
  expect(await f.repo.adapterState('qq', report('logged_out'))).toBeNull();
  expect(await f.repo.adapterState('qq', report('logged_in', 'fixture-account', 'Fixture alias'))).toBeNull();
  expect(await f.repo.adapterOffline('qq', { observeOutage: false })).toBeNull();
  expect(f.row).toMatchObject(report('offline', 'fixture-account', 'Fixture alias'));
  expect(f.row.capabilities).toEqual({ [marker]: true });
  expect(f.alerts).toHaveLength(0);
});

it('raises once on durable loss, retains acknowledgement and allows another incident after recovery', async () => {
  const f = fixture('logged_in'); // Existing installations have no private login marker.
  await f.repo.adapterState('qq', report('login_pending'));
  await f.repo.adapterState('qq', report('error'));
  await f.repo.adapterCapabilities('qq', { login: true, _voipgwObservedLogin: false });
  expect(f.armed).toBe(true);
  expect(await f.repo.list()).toEqual([{ platform: 'qq', ...f.row, capabilities: capabilities(true) }]);
  const raised = await f.repo.adapterState('qq', report('banned'));
  expect(raised?.type).toBe('alert.raised');
  expect(adminAlert.safeParse(raised?.data).success).toBe(true);
  expect(f.query.mock.calls.at(-1)?.[0]).toBe('COMMIT');
  const first = f.alerts[0]!;
  first.state = 'acked';
  expect(await f.repo.adapterOffline('qq')).toBeNull();
  expect(f.alerts).toHaveLength(1);
  const resolved = await f.repo.adapterState('qq', report('logged_in'));
  expect(resolved).toMatchObject({ type: 'alert.resolved', data: { id: first.id, state: 'acked', resolvedAt: 2 } });
  expect(await f.repo.adapterOffline('qq')).toMatchObject({ type: 'alert.raised', data: { state: 'open' } });
  expect(f.alerts[1]?.id).not.toBe(first.id);
});

it('does not invent an outage on planned restart and preserves evidence for the next real observation', async () => {
  const f = fixture('logged_in');
  expect(await f.repo.adapterOffline('qq', { observeOutage: false })).toBeNull();
  expect(f.armed).toBe(true);
  expect(await f.repo.adapterOffline('qq', { observeOutage: 'persisted-login' })).toBeNull();
  expect(f.armed).toBe(true);
  expect(await f.repo.adapterOffline('qq')).toMatchObject({ type: 'alert.raised' });
  expect(await f.repo.adapterOffline('qq')).toBeNull();
  expect(f.alerts).toHaveLength(1);
});

it('reconciles a logged-in state left by an interrupted Core', async () => {
  const f = fixture('logged_in');
  expect(await f.repo.adapterOffline('qq', { observeOutage: 'persisted-login' })).toMatchObject({ type: 'alert.raised' });
  expect(f.row).toMatchObject({ state: 'offline' });
  expect(f.armed).toBe(false);
  expect(await f.repo.adapterOffline('qq', { observeOutage: 'persisted-login' })).toBeNull();
});

it.each([true, false])('commits bootstrap and recovery together with initial login support %s', async login => {
  const f = fixture('offline', true);
  f.row.capabilities = { login: true, sendMessage: true, dial: true, [marker]: true };
  const prior = structuredClone(f.row);
  const alert = incident('alr_fixture');
  f.alerts.push(alert);
  const atCommit = gate();
  const resume = gate();
  f.before.set('COMMIT', () => { atCommit.open(); return resume.wait; });

  const next = report('logged_in', 'fixture-new', 'New fixture alias');
  const pending = f.repo.adapterState('qq', next, { initialLoginSupport: login });
  try {
    await Promise.race([atCommit.wait, pending]);
    expect(f.steps()).toEqual([...setup, rowLock, stateWrite, resolve, 'COMMIT']);
    expect(f.connect).toHaveBeenCalledOnce();
    expect(f.release).not.toHaveBeenCalled();
    expect(f.row).toEqual(prior);
    expect(await f.repo.list()).toEqual([{ platform: 'qq', ...prior, capabilities: capabilities(true) }]);
    expect(f.alerts).toEqual([alert]);
  } finally {
    resume.open();
  }
  expect(await pending).toMatchObject({ type: 'alert.resolved', data: { id: alert.id, state: 'resolved' } });
  expect(f.row).toEqual({ ...next, capabilities: { ...capabilities(login), [marker]: true } });
  expect(await f.repo.list()).toEqual([{ platform: 'qq', ...next, capabilities: capabilities(login) }]);
  expect(f.release.mock.calls).toEqual([[]]);
});

it('preserves stored capabilities on state-only writes and gates legacy capability readback', async () => {
  const f = fixture('offline', true);
  const stored = { ...capabilities(true), login: 'true', sendMessage: true, dial: true, fixtureExtra: 'fixture-value', [marker]: true };
  f.row.capabilities = { ...stored };
  await f.repo.adapterState('qq', report('login_pending'));
  await f.repo.adapterState('qq', report('error'), { initialLoginSupport: undefined });
  expect(f.row.capabilities).toEqual(stored);
  expect(await f.repo.list()).toEqual([{ platform: 'qq', ...f.row, capabilities: capabilities(false) }]);
});

it.each([
  { name: 'exact true', value: { login: true, sendMessage: true, receiveMessage: true, dial: true,
    receiveAudio: true, sendAudio: true, maxConcurrentCalls: 9, [marker]: false, token: 'fixture-value' }, login: true },
  { name: 'string true', value: { login: 'true' }, login: false },
  { name: 'number one', value: { login: 1 }, login: false },
  { name: 'false', value: { login: false }, login: false },
  { name: 'array', value: Object.assign([], { login: true }), login: false },
  { name: 'inherited login', value: Object.create({ login: true }), login: false },
  { name: 'accessor login', value: { get login() { throw new Error('adapter accessor ran'); } }, login: false },
  { name: 'primitive true', value: true, login: false },
  { name: 'null', value: null, login: false },
])('normalizes later reports from $name and preserves the database marker', async ({ value, login }) => {
  const f = fixture('error', true);
  await expect(f.repo.adapterCapabilities('qq', value)).resolves.toBeUndefined();
  expect(f.steps()).toEqual([...setup, rowLock, capabilityWrite, 'COMMIT']);
  expect(f.poolQuery).not.toHaveBeenCalled();
  expect(f.row).toEqual({ ...report('error', 'fixture-account', 'Fixture alias'), capabilities: { ...capabilities(login), [marker]: true } });
  expect(await f.repo.list()).toEqual([{ platform: 'qq', ...f.row, capabilities: capabilities(login) }]);
});

it('cannot forge the observed-login marker through a capability report', async () => {
  const f = fixture();
  await f.repo.adapterCapabilities('qq', { login: true, [marker]: true });
  expect(f.row.capabilities).toEqual(capabilities(true));
  expect(await f.repo.adapterOffline('qq')).toBeNull();
  expect(f.alerts).toHaveLength(0);
});

it('does not acquire a client for an already stale capability report', async () => {
  const f = fixture('logged_in', true);
  expect(await f.repo.adapterCapabilities('qq', { login: false }, { isCurrent: () => false })).toBeUndefined();
  expect(f.connect).not.toHaveBeenCalled();
  expect(f.query).not.toHaveBeenCalled();
});

it('rolls back a stale offline write upon acquiring the row lock', async () => {
  const f = fixture('logged_in', true);
  const prior = structuredClone(f.row);
  let active = true;
  f.after.set(rowLock, () => { active = false; });
  expect(await f.repo.adapterOffline('qq', { isCurrent: () => active })).toBeNull();
  expect(f.steps()).toEqual([...setup, rowLock, 'ROLLBACK']);
  expect(f.row).toEqual(prior);
  expect(f.alerts).toHaveLength(0);
  expect(f.release).toHaveBeenLastCalledWith(true);
});

it.each([
  { boundary: stateWrite, steps: [stateWrite] },
  { boundary: resolve, steps: [stateWrite, resolve] },
])('rolls back a bootstrap invalidated after $boundary', async ({ boundary, steps }) => {
  const f = fixture('offline', true);
  const prior = structuredClone(f.row);
  const alert = incident('alr_fixture');
  f.alerts.push(alert);
  let active = true;
  f.after.set(boundary, () => { active = false; });

  const event = await f.repo.adapterState('qq', report('logged_in', 'fixture-new'), { initialLoginSupport: false, isCurrent: () => active });
  expect(event).toBeNull();
  expect(f.steps()).toEqual([...setup, rowLock, ...steps, 'ROLLBACK']);
  expect(f.row).toEqual(prior);
  expect(f.alerts).toEqual([alert]);
  expect(f.release.mock.calls).toEqual([[true]]);
});

it('rechecks the capability generation after work returns and directly before COMMIT', async () => {
  const f = fixture('error', true);
  const prior = structuredClone(f.row);
  let active = true;
  let updated = false;
  let invalidationQueued = false;
  f.after.set(capabilityWrite, () => { updated = true; });

  await expect(f.repo.adapterCapabilities('qq', { login: false }, { isCurrent: () => {
    if (updated && !invalidationQueued) {
      invalidationQueued = true;
      queueMicrotask(() => { active = false; });
    }
    return active;
  } })).resolves.toBeUndefined();
  expect(invalidationQueued).toBe(true);
  expect(f.steps()).toEqual([...setup, rowLock, capabilityWrite, 'ROLLBACK']);
  expect(f.row).toEqual(prior);
  expect(f.release.mock.calls).toEqual([[true]]);
});

it('preserves prior account, capabilities and alerts if the bootstrap alert write fails', async () => {
  const f = fixture('logged_in', true);
  const prior = structuredClone(f.row);
  const history = { ...incident('alr_historical'), state: 'resolved' as const, resolvedAt: 2 };
  f.alerts.push(history);
  const failure = new Error('alert write failed');
  f.after.set(raise, () => { throw failure; });

  await expect(f.repo.adapterState('qq', report('banned', 'fixture-new'), { initialLoginSupport: false })).rejects.toBe(failure);
  expect(f.steps()).toEqual([...setup, rowLock, stateWrite, raise, 'ROLLBACK']);
  expect(f.row).toEqual(prior);
  expect(f.alerts).toEqual([history]);
  expect(f.release.mock.calls).toEqual([[true]]);
});

it.each(['lost response before commit', 'ROLLBACK tag', 'lost response after commit'] as const)(
  'keeps a bootstrap with %s from reporting success', async outcome => {
    const f = fixture('offline', true);
    const prior = structuredClone(f.row);
    const alert = incident('alr_fixture');
    f.alerts.push(alert);
    const failure = new Error('commit response lost');
    const fail = () => { throw failure; };
    if (outcome === 'ROLLBACK tag') f.commitReturns('ROLLBACK');
    else (outcome === 'lost response before commit' ? f.before : f.after).set('COMMIT', fail);
    const next = report('logged_in', 'fixture-new');

    const pending = f.repo.adapterState('qq', next, { initialLoginSupport: false });
    if (outcome === 'ROLLBACK tag') {
      await expect(pending).rejects.toBeInstanceOf(TransactionRolledBack);
    } else {
      await expect(pending).rejects.toBeInstanceOf(TransactionCommitUnknown);
      await expect(pending).rejects.toHaveProperty('cause', failure);
    }
    expect(f.steps()).toEqual([...setup, rowLock, stateWrite, resolve, 'COMMIT', 'ROLLBACK']);
    expect(f.release.mock.calls).toEqual([[true]]);
    if (outcome === 'lost response after commit') {
      expect(f.row).toEqual({ ...next, capabilities: { ...capabilities(false), [marker]: true } });
      expect(f.alerts).toEqual([{ ...alert, state: 'resolved', resolvedAt: 2 }]);
    } else {
      expect(f.row).toEqual(prior);
      expect(f.alerts).toEqual([alert]);
    }
  },
);

it('propagates a real capability write failure even if the generation also changes', async () => {
  const f = fixture('error', true);
  const prior = structuredClone(f.row);
  let active = true;
  const failure = new Error('Channel observation is no longer current');
  f.after.set(capabilityWrite, () => { active = false; throw failure; });
  await expect(f.repo.adapterCapabilities('qq', { login: false }, { isCurrent: () => active })).rejects.toBe(failure);
  expect(f.steps()).toEqual([...setup, rowLock, capabilityWrite, 'ROLLBACK']);
  expect(f.row).toEqual(prior);
});

it.each(['rollback', 'release'] as const)('propagates %s failure when discarding a stale capability report', async stage => {
  const f = fixture('error', true);
  const prior = structuredClone(f.row);
  let active = true;
  const failure = new Error(stage + ' failed');
  const fail = () => { throw failure; };
  f.after.set(capabilityWrite, () => { active = false; });
  if (stage === 'rollback') f.before.set('ROLLBACK', fail);
  else f.release.mockImplementationOnce(fail);

  const pending = f.repo.adapterCapabilities('qq', { login: false }, { isCurrent: () => active });
  await expect(pending).rejects.toBeInstanceOf(AggregateError);
  await expect(pending).rejects.toHaveProperty('errors.1', failure);
  expect(f.steps()).toEqual([...setup, rowLock, capabilityWrite, 'ROLLBACK']);
  expect(f.row).toEqual(prior);
  expect(f.release.mock.calls).toEqual([[true]]);
});

it('propagates a lost capability commit response after the generation changes', async () => {
  const f = fixture('error', true);
  let active = true;
  const failure = new Error('commit response lost');
  f.after.set('COMMIT', () => { active = false; throw failure; });

  const pending = f.repo.adapterCapabilities('qq', { login: false }, { isCurrent: () => active });
  await expect(pending).rejects.toBeInstanceOf(TransactionCommitUnknown);
  await expect(pending).rejects.toHaveProperty('cause', failure);
  expect(f.steps()).toEqual([...setup, rowLock, capabilityWrite, 'COMMIT', 'ROLLBACK']);
  expect(f.row.capabilities).toEqual({ ...capabilities(false), [marker]: true });
  expect(f.release.mock.calls).toEqual([[true]]);
});

it('propagates a release failure after a confirmed capability commit', async () => {
  const f = fixture('error', true);
  const failure = new Error('release failed');
  f.release.mockImplementationOnce(() => { throw failure; });

  const pending = f.repo.adapterCapabilities('qq', { login: false });
  await expect(pending).rejects.toBeInstanceOf(TransactionReleaseFailed);
  await expect(pending).rejects.toHaveProperty('cause', failure);
  expect(f.steps()).toEqual([...setup, rowLock, capabilityWrite, 'COMMIT']);
  expect(f.row.capabilities).toEqual({ ...capabilities(false), [marker]: true });
  expect(f.release.mock.calls).toEqual([[]]);
});
