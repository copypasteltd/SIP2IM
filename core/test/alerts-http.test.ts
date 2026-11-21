import { describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import type pg from 'pg';
import { registerOperations } from '../src/http/operations.js';

const headers = { authorization: 'Bearer fixture-session' };
const time = (micros: string) => '2026-11-21 09:15:00.' + micros + '+00';
const row = (id: string, micros: string, state = 'open') => ({ id, state, cursorTime: time(micros), firstAt: 1795252500000 });
const token = (state: string | null, at: string, id: string) => Buffer.from(JSON.stringify({ v: 1, state, time: at, id })).toString('base64url');
function fixture(query: (sql: string, args: unknown[]) => Promise<unknown>) {
  const app = Fastify();
  registerOperations(app, { query } as unknown as pg.Pool, async supplied => supplied === 'fixture-session' ? 'admin' : null);
  return app;
}

describe('alert history routes', () => {
  it('requires authentication and preserves the exact legacy unpaged contract', async () => {
    const rows = Array.from({ length: 55 }, (_, i) => ({ id: String(i), state: 'open', firstAt: 1000 }));
    const query = vi.fn(async (_sql: string, _args: unknown[]) => ({ rows }));
    const app = fixture(query);
    try {
      const unauthorized = await app.inject('/api/alerts?limit=2');
      expect(unauthorized.statusCode).toBe(401);
      expect(unauthorized.headers['cache-control']).toBe('no-store');
      expect(query).not.toHaveBeenCalled();
      const response = await app.inject({ url: '/api/alerts?state=open', headers });
      expect(response.statusCode).toBe(200);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.json()).toEqual({ data: rows, nextCursor: null });
      expect(query.mock.calls[0]?.[1]).toEqual(['open']);
      expect(query.mock.calls[0]?.[0]).not.toMatch(/LIMIT/i);
      await app.inject({ url: '/api/alerts', headers });
      expect(query.mock.calls[1]?.[1]).toEqual([null]);
    } finally { await app.close(); }
  });

  it('pages by exact first_at and ID without moving the boundary after a new alert', async () => {
    let records = [row('newer', '000002'), row('z', '000001'), row('a', '000001'), row('older', '000000'), row('acked', '000003', 'acked')];
    const query = vi.fn(async (sql: string, args: unknown[]) => {
      expect(sql).toContain('first_at,id)<($2::timestamptz,$3::text)');
      expect(sql).toContain("first_at AT TIME ZONE 'UTC','YYYY-MM-DD HH24:MI:SS.US'");
      expect(sql).toContain('ORDER BY first_at DESC,id DESC LIMIT $4');
      const [state, at, id, limit] = args as [string | null, string | null, string | null, number];
      const rows = records.filter(r => (state === null || r.state === state) &&
        (at === null || r.cursorTime < at || (r.cursorTime === at && r.id < id!)))
        .sort((a,b) => a.cursorTime === b.cursorTime ? (a.id > b.id ? -1 : 1) : (a.cursorTime > b.cursorTime ? -1 : 1)).slice(0, limit);
      return { rows };
    });
    const app = fixture(query);
    try {
      const response = await app.inject({ url: '/api/alerts?limit=2&state=open', headers });
      expect(response.statusCode).toBe(200);
      const first = response.json();
      expect(first.data.map((r: { id: string }) => r.id)).toEqual(['newer','z']);
      expect(first.data.every((r: object) => !Object.hasOwn(r,'cursorTime'))).toBe(true);
      expect(first.nextCursor).toBe(token('open', time('000001'), 'z'));
      expect(query.mock.calls[0]?.[1]).toEqual(['open',null,null,3]);
      records = [row('inserted','999999'), ...records];
      const second = await app.inject({ url: '/api/alerts?limit=2&state=open&cursor=' + first.nextCursor, headers });
      expect(second.statusCode).toBe(200);
      expect(second.json().data.map((r: { id: string }) => r.id)).toEqual(['a','older']);
      expect(second.json().nextCursor).toBeNull();
      expect(query.mock.calls[1]?.[1]).toEqual(['open',time('000001'),'z',3]);
      await app.inject({ url: '/api/alerts?state=open&cursor=' + first.nextCursor, headers });
      expect(query.mock.calls[2]?.[1]).toEqual(['open',time('000001'),'z',51]);
    } finally { await app.close(); }
  });

  it('rejects invalid page arguments, cross-state and noncanonical cursors before querying', async () => {
    const query = vi.fn(async (_sql: string, _args: unknown[]) => ({ rows: [] }));
    const app = fixture(query);
    const cursor = token('open', time('000001'), 'fixture');
    const extra = Buffer.from(JSON.stringify({ v: 1, state: 'open', time: time('000001'), id: 'fixture', extra: 1 })).toString('base64url');
    const bad = [
      'state=bogus', 'other=x', 'state=open&state=acked', 'limit=1&limit=2',
      'limit=', 'limit=0', 'limit=101', 'limit=1.5', 'limit=1e1', 'limit=%201', 'limit=1%0A',
      'cursor=', 'cursor=not%2Ba%2Ftoken', 'cursor=' + 'a'.repeat(1025),
      'state=open&cursor=' + cursor + '=', 'cursor=' + cursor, 'state=acked&cursor=' + cursor,
      'state=open&cursor=' + token('open', '2026-02-30 00:00:00.000001+00', 'fixture'),
      'state=open&cursor=' + token('open', time('000001') + '\n', 'fixture'),
      'state=open&cursor=' + token('open', time('000001'), 'bad\0id'), 'state=open&cursor=' + extra,
    ];
    try {
      for (const queryString of bad) {
        const response = await app.inject({ url: '/api/alerts?' + queryString, headers });
        expect(response.statusCode, queryString).toBe(400);
        expect(response.json().error.code).toBe('BAD_REQUEST');
      }
      expect(query).not.toHaveBeenCalled();
      const empty = await app.inject({ url: '/api/alerts?limit=100', headers });
      expect(empty.json()).toEqual({ data: [], nextCursor: null });
      expect(query.mock.calls[0]?.[1]).toEqual([null,null,null,101]);
    } finally { await app.close(); }
  });

  it('reports an invalid stored boundary rather than emitting an unusable cursor', async () => {
    const query = vi.fn(async () => ({ rows: [{ id: 'one', cursorTime: 'invalid' }, row('two','000000')] }));
    const app = fixture(query);
    try {
      const response = await app.inject({ url: '/api/alerts?limit=1', headers });
      expect(response.statusCode).toBe(500);
      expect(response.json()).toEqual({ error: { code: 'INTERNAL', message: 'INTERNAL', details: null } });
    } finally { await app.close(); }
  });
});
