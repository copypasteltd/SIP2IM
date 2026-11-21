import { adminAlert } from '@voipgw/protocol';
import type pg from 'pg';
import { expect, it, vi } from 'vitest';
import { ChannelRepository } from '../src/channels/repo.js';

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
const report = (state: string) => ({ state, selfId: null, alias: null });

function fixture(state = 'logged_out', armed = false) {
  const row = { state, armed, capabilities: { login: true } as Record<string, unknown> };
  const alerts: Alert[] = [];
  let previous = { row: { ...row }, alerts: [] as Alert[] };
  let readLock = () => {};
  let failed = '';
  const release = vi.fn();
  const result = (rows: unknown[], rowCount = rows.length, command = 'SELECT') => ({ rows, rowCount, command });
  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    if (sql === failed) throw new Error('database error');
    if (sql === 'BEGIN') { previous = { row: { ...row }, alerts: alerts.map(alert => ({ ...alert })) }; return result([], 0, sql); }
    if (sql === 'ROLLBACK') { Object.assign(row, previous.row); alerts.splice(0, alerts.length, ...previous.alerts); return result([], 0, sql); }
    if (sql === 'COMMIT') return result([], 0, sql);
    if (sql.startsWith('SELECT state,')) {
      expect(sql).toContain('WHERE platform=$1 FOR UPDATE');
      expect(params).toEqual(['qq']);
      readLock();
      return result([row]);
    }
    if (sql.startsWith('UPDATE channel SET state=')) {
      expect(params[0]).toBe('qq');
      row.state = String(params[1]); row.armed = params[5] === true;
      if (params[2] === false) row.capabilities = {};
      return result([], 1);
    }
    if (sql.startsWith('UPDATE channel SET capabilities=')) {
      expect(sql).toContain("$2::jsonb-'_voipgwObservedLogin'");
      expect(sql).toContain("capabilities->'_voipgwObservedLogin'='true'::jsonb");
      const decoded = JSON.parse(String(params[1]));
      delete decoded._voipgwObservedLogin;
      row.capabilities = decoded;
      return result([], 1);
    }
    if (sql.startsWith('SELECT c.platform,')) {
      expect(sql).toContain("c.capabilities-'_voipgwObservedLogin'");
      return result([{ platform: 'qq', capabilities: row.capabilities }]);
    }
    if (sql.startsWith('UPDATE alert SET state=')) {
      expect(params).toEqual(['channel_down', 'channel', 'qq']);
      const open = alerts.find(alert => alert.resolvedAt === null);
      if (!open) return result([]);
      if (open.state === 'open') open.state = 'resolved';
      open.resolvedAt = 2;
      return result([{ ...open }]);
    }
    if (sql.startsWith('INSERT INTO alert(')) {
      expect(params.slice(0, 3)).toEqual(['channel_down', 'channel', 'qq']);
      expect(params[4]).toBe(false);
      expect(sql).toContain("state IN ('open','acked') AND resolved_at IS NULL");
      expect(sql).toContain("ON CONFLICT (type,subject_id) WHERE state='open' DO NOTHING");
      if (alerts.some(alert => alert.resolvedAt === null)) return result([]);
      const alert: Alert = { id: String(params[3]), type: 'channel_down', subjectType: 'channel', subjectId: 'qq',
        severity: 'warning', state: 'open', detail: {}, firstAt: 1, lastAt: 1, pushedAt: null, resolvedAt: null };
      alerts.push(alert);
      return result([{ ...alert }]);
    }
    throw new Error('Unexpected query: ' + sql);
  });
  const pool = { query, connect: async () => ({ query, release }) } as unknown as pg.Pool;
  return { repo: new ChannelRepository(pool), row, alerts, release, query,
    afterLock(fn: () => void) { readLock = fn; }, fail(sql: string) { failed = sql; } };
}

it('does not alert on a never-logged-in channel or an attachment reset alone', async () => {
  const f = fixture();
  expect(await f.repo.adapterOffline('qq')).toBeNull();
  expect(await f.repo.adapterState('qq', report('logged_out'))).toBeNull();
  expect(await f.repo.adapterState('qq', report('logged_in'))).toBeNull();
  expect(await f.repo.adapterOffline('qq', { observeOutage: false })).toBeNull();
  expect(f.row).toMatchObject({ state: 'offline', armed: true, capabilities: {} });
  expect(f.alerts).toHaveLength(0);
});

it('raises once on durable loss, retains acknowledgement and allows another incident after recovery', async () => {
  const f = fixture('logged_in'); // Existing installations have no private login marker.
  await f.repo.adapterState('qq', report('login_pending'));
  await f.repo.adapterState('qq', report('error'));
  await f.repo.adapterCapabilities('qq', { login: true, _voipgwObservedLogin: false });
  expect(f.row.armed).toBe(true);
  expect(await f.repo.list()).toEqual([{ platform: 'qq', capabilities: { login: true } }]);
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
  expect(f.row.armed).toBe(true);
  expect(await f.repo.adapterOffline('qq', { observeOutage: 'persisted-login' })).toBeNull();
  expect(f.row.armed).toBe(true);
  expect(await f.repo.adapterOffline('qq')).toMatchObject({ type: 'alert.raised' });
  expect(await f.repo.adapterOffline('qq')).toBeNull();
  expect(f.alerts).toHaveLength(1);
});

it('reconciles a logged-in state left by an interrupted Core', async () => {
  const f = fixture('logged_in');
  expect(await f.repo.adapterOffline('qq', { observeOutage: 'persisted-login' })).toMatchObject({ type: 'alert.raised' });
  expect(f.row).toMatchObject({ state: 'offline', armed: false });
  expect(await f.repo.adapterOffline('qq', { observeOutage: 'persisted-login' })).toBeNull();
});

it('rolls back an obsolete report after acquiring the row lock and does not publish unknown commits', async () => {
  const f = fixture('logged_in');
  let active = true;
  f.afterLock(() => { active = false; });
  expect(await f.repo.adapterOffline('qq', { isCurrent: () => active })).toBeNull();
  expect(f.query.mock.calls.map(([sql]) => sql).at(-1)).toBe('ROLLBACK');
  expect(f.query.mock.calls.some(([sql]) => sql.startsWith('UPDATE channel'))).toBe(false);
  expect(f.release).toHaveBeenLastCalledWith(true);
  f.fail('COMMIT');
  await expect(f.repo.adapterOffline('qq')).rejects.toThrow('COMMIT outcome is uncertain');
});
