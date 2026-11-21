import { it, expect, vi } from 'vitest';
import type pg from 'pg';
import { TransactionCommitUnknown } from '../src/db/pool.js';
import type { CallState } from '../src/calls/coordinator.js';
import { reconcileCalls } from '../src/calls/reconcile.js';
import { unarmedWebReservation } from '../src/calls/web-reservations.js';

type Session = { id: string; state: CallState; unarmed: boolean };
type Query = { sql: string; args: unknown[] };
type Reply = { rowCount: number; rows: Session[]; command: string };
const pageSelect = 'SELECT s.id,s.state,';
const proofSelect = 'SELECT 1 FROM call_session s WHERE s.id=$1';
const sessionLock = 'SELECT id FROM call_session WHERE id=$1 FOR UPDATE';
const setup = ['BEGIN', 'SET TRANSACTION ISOLATION LEVEL READ COMMITTED', 'SET LOCAL synchronous_commit = on'];
const row = (id: string, state: CallState, unarmed = false): Session => ({ id, state, unarmed });
const fullPage = (): Session[] => Array.from({ length: 64 }, (_, i) =>
  row('ses_' + String(i).padStart(2, '0'), i === 63 ? 'ended' : 'rejecting'));
const reply = (rowCount: number, command: string, rows: Session[] = []): Reply => ({ rowCount, rows, command });

function fixture(pages: Session[][], intercept?: (query: Query) => Reply | void) {
  const queries: Query[] = [];
  let page = 0;
  const client = {
    query: vi.fn(async (sql: string, args: unknown[] = []) => {
      const query = { sql, args };
      queries.push(query);
      const intercepted = intercept?.(query);
      if (intercepted) return intercepted;
      if (sql.startsWith(pageSelect)) {
        const rows = pages[page++];
        if (!rows) throw new Error('Unexpected recovery page');
        return reply(rows.length, 'SELECT', rows);
      }
      if (sql === sessionLock || sql.startsWith(proofSelect)) return reply(1, 'SELECT');
      if (sql.startsWith('UPDATE call_leg')) return reply(2, 'UPDATE');
      if (sql.startsWith('UPDATE call_')) return reply(1, 'UPDATE');
      if (sql.startsWith('INSERT INTO call_event')) return reply(1, 'INSERT');
      if (setup.includes(sql) || sql === 'COMMIT' || sql === 'ROLLBACK') return reply(0, sql);
      throw new Error('Unexpected recovery SQL: ' + sql);
    }),
    release: vi.fn(),
  };
  const connect = vi.fn(async () => client);
  return {
    connect, release: client.release, pool: { connect } as unknown as pg.Pool,
    matching: (prefix: string) => queries.filter(({ sql }) => sql.startsWith(prefix)),
    sql: () => queries.map(({ sql }) => sql),
  };
}

it('uses a bounded PK keyset and counts committed transitions across eligibility branches', async () => {
  const first = fullPage();
  const bridged = row('ses_72', 'bridged');
  const second = [row('ses_70', 'unknown'), row('ses_71', 'ended'), bridged];
  const f = fixture([first, second]);

  expect(await reconcileCalls(f.pool, vi.fn())).toBe(64);
  const pages = f.matching(pageSelect);
  expect(pages.map(({ args }) => args)).toEqual([[64], [64, 'ses_63']]);
  for (const { sql } of pages) {
    expect(sql).toContain("(s.state NOT IN ('ended','unknown')");
    expect(sql).toContain("OR EXISTS (SELECT 1 FROM call_reject_intent i WHERE i.session_id=s.id AND i.state IN ('pending','sending','accepted'))");
    expect(sql).toContain("OR EXISTS (SELECT 1 FROM call_outbound_attempt a WHERE a.session_id=s.id AND (a.ack_state='pending' OR a.callback_intent='quarantined')))");
    expect(sql).toContain('ORDER BY s.id LIMIT $1 FOR UPDATE OF s');
  }
  expect(pages[1]?.sql).toContain('s.id>$2::text AND (');
  for (const { sql } of f.matching('UPDATE call_reject_intent')) {
    expect(sql).toContain("WHERE session_id=$1 AND state IN ('pending','sending','accepted')");
  }
  for (const { sql } of f.matching('UPDATE call_outbound_attempt')) {
    expect(sql).toContain("WHERE session_id=$1 AND (ack_state='pending' OR callback_intent='quarantined')");
  }
  const ids = [...first, ...second].map(({ id }) => [id]);
  expect(f.matching('UPDATE call_reject_intent').map(({ args }) => args)).toEqual(ids);
  expect(f.matching('UPDATE call_outbound_attempt').map(({ args }) => args)).toEqual(ids);
  const transitions = [...first.slice(0, 63), bridged];
  expect(f.matching('UPDATE call_session').map(({ args }) => args)).toEqual(
    transitions.map(({ id, state }) => [id, state, 'unknown', 'unknown']),
  );
  expect(f.matching('INSERT INTO call_event').map(({ args }) => args.slice(1))).toEqual(
    transitions.map(({ id }) => [id, 'state:unknown', JSON.stringify({ reason: 'core_restart' })]),
  );
  expect(f.sql().filter(sql => setup.includes(sql) || sql === 'COMMIT')).toEqual([...setup, 'COMMIT', ...setup, 'COMMIT']);
  expect(f.release.mock.calls).toEqual([[], []]);
});

it('uses a fresh locked proof, with a missing or stale proof leaving the call uncertain', async () => {
  const f = fixture([[row('ses_a', 'awaiting_browser', true), row('ses_b', 'awaiting_browser', true), row('ses_c', 'awaiting_browser')]],
    ({ sql, args }) => sql.startsWith(proofSelect) && args[0] === 'ses_b' ? reply(0, 'SELECT') : undefined);

  expect(await reconcileCalls(f.pool, vi.fn())).toBe(3);
  expect(f.matching(pageSelect)[0]?.sql).toContain(`(${unarmedWebReservation}) AS unarmed`);
  expect(f.matching(sessionLock).map(({ args }) => args)).toEqual([['ses_a'], ['ses_b']]);
  const proofs = f.matching(proofSelect);
  expect(proofs.map(({ args }) => args)).toEqual([['ses_a', false], ['ses_b', false]]);
  for (const { sql } of proofs) expect(sql).toContain(unarmedWebReservation);
  const statements = f.sql();
  expect(statements.indexOf(sessionLock)).toBeLessThan(statements.indexOf(proofs[0]!.sql));
  expect(statements.indexOf(proofs[0]!.sql)).toBeLessThan(statements.indexOf(f.matching('UPDATE call_outbound_attempt')[0]!.sql));
  expect(f.matching('UPDATE call_leg').map(({ args }) => args)).toEqual([['ses_a']]);
  expect(f.matching('UPDATE call_session').map(({ args }) => args)).toEqual([
    ['ses_a', 'awaiting_browser', 'ended', null],
    ['ses_b', 'awaiting_browser', 'unknown', 'unknown'],
    ['ses_c', 'awaiting_browser', 'unknown', 'unknown'],
  ]);
  expect(f.matching('INSERT INTO call_event').map(({ args }) => args.slice(1))).toEqual([
    ['ses_a', 'state:ended', JSON.stringify({ reason: 'core_restart_before_dial' })],
    ['ses_b', 'state:unknown', JSON.stringify({ reason: 'core_restart' })],
    ['ses_c', 'state:unknown', JSON.stringify({ reason: 'core_restart' })],
  ]);
  expect(statements.at(-1)).toBe('COMMIT');
});

it('visits an empty next page after an exactly full page and returns the committed count', async () => {
  const f = fixture([fullPage(), []]);

  expect(await reconcileCalls(f.pool, vi.fn())).toBe(63);
  expect(f.matching(pageSelect).map(({ args }) => args)).toEqual([[64], [64, 'ses_63']]);
  expect(f.matching('COMMIT')).toHaveLength(2);
});

it('requires ownership before opening a connection', async () => {
  const f = fixture([]);
  const lost = new Error('ownership lost');
  await expect(reconcileCalls(f.pool, () => { throw lost; })).rejects.toBe(lost);
  expect(f.connect).not.toHaveBeenCalled();
});

it.each(['before the locking query', 'before the first record'])('rolls back if ownership is lost %s', async boundary => {
  let held = true;
  const lost = new Error('ownership lost');
  const f = fixture([[row('ses_a', 'rejecting')]], ({ sql }) => {
    if (sql.startsWith(boundary === 'before the locking query' ? setup[2]! : pageSelect)) held = false;
  });
  await expect(reconcileCalls(f.pool, () => { if (!held) throw lost; })).rejects.toBe(lost);
  expect(f.matching(pageSelect)).toHaveLength(boundary === 'before the locking query' ? 0 : 1);
  expect(f.matching('UPDATE ')).toHaveLength(0);
  expect(f.sql().at(-1)).toBe('ROLLBACK');
  expect(f.release).toHaveBeenCalledWith(true);
});

it.each([
  { boundary: 'before a later record', page: [row('ses_a', 'rejecting'), row('ses_b', 'bridged')] },
  { boundary: 'before commit', page: [row('ses_a', 'rejecting')] },
])('rolls back if ownership is lost $boundary', async ({ page }) => {
  let held = true;
  const lost = new Error('ownership lost');
  const f = fixture([page], ({ sql }) => {
    if (sql.startsWith('INSERT INTO call_event')) held = false;
  });
  await expect(reconcileCalls(f.pool, () => { if (!held) throw lost; })).rejects.toBe(lost);
  expect(f.matching('UPDATE call_outbound_attempt').map(({ args }) => args)).toEqual([['ses_a']]);
  expect(f.matching('COMMIT')).toHaveLength(0);
  expect(f.sql().at(-1)).toBe('ROLLBACK');
  expect(f.release).toHaveBeenCalledWith(true);
});

it('throws after ownership loss between batches and opens no further transaction', async () => {
  const f = fixture([fullPage()]);
  let held = true;
  f.release.mockImplementation(() => { held = false; });
  const lost = new Error('ownership lost');

  await expect(reconcileCalls(f.pool, () => { if (!held) throw lost; })).rejects.toBe(lost);
  expect(f.connect).toHaveBeenCalledTimes(1);
  expect(f.matching('COMMIT')).toHaveLength(1);
  expect(f.matching('ROLLBACK')).toHaveLength(0);
});

it('rolls back the current batch if recording a state event fails', async () => {
  const failure = new Error('database failure');
  const f = fixture([fullPage(), [row('ses_70', 'rejecting')]], ({ sql, args }) => {
    if (sql.startsWith('INSERT INTO call_event') && args[1] === 'ses_70') throw failure;
  });
  await expect(reconcileCalls(f.pool, vi.fn())).rejects.toBe(failure);
  expect(f.matching('COMMIT')).toHaveLength(1);
  expect(f.sql().at(-1)).toBe('ROLLBACK');
  expect(f.release.mock.calls).toEqual([[], [true]]);
});

it('propagates a lost commit result and opens no further transaction', async () => {
  const f = fixture([fullPage()], ({ sql }) => {
    if (sql === 'COMMIT') throw new Error('commit response lost');
  });
  await expect(reconcileCalls(f.pool, vi.fn())).rejects.toBeInstanceOf(TransactionCommitUnknown);
  expect(f.connect).toHaveBeenCalledTimes(1);
  expect(f.sql().slice(-2)).toEqual(['COMMIT', 'ROLLBACK']);
  expect(f.release).toHaveBeenCalledWith(true);
});
