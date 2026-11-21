import {describe, expect, it, vi} from 'vitest';
import Fastify from 'fastify';
import type pg from 'pg';
import {registerOperations} from '../src/http/operations.js';

describe('alert routes', () => {
  it('authenticates and applies the requested state without silently truncating results', async () => {
    const rows = Array.from({length: 55}, (_, i) => ({id: String(i), state: 'open', firstAt: 1000}));
    const query = vi.fn(async (_sql: string, _args?: unknown[]) => ({rows, rowCount: rows.length}));
    const app = Fastify();
    registerOperations(app, {query} as unknown as pg.Pool, async token => token === 'ok' ? 'admin' : null);
    try {
      expect((await app.inject({method: 'GET', url: '/api/alerts?state=open'})).statusCode).toBe(401);
      expect(query).not.toHaveBeenCalled();
      const response = await app.inject({method: 'GET', url: '/api/alerts?state=open', headers: {authorization: 'Bearer ok'}});
      expect(response.statusCode).toBe(200);
      expect(response.json().data).toHaveLength(55);
      expect(query.mock.calls[0]![1]).toEqual(['open']);
      expect(query.mock.calls[0]![0]).toContain('state=$1');
      expect(query.mock.calls[0]![0]).not.toMatch(/LIMIT/i);
      await app.inject({method: 'GET', url: '/api/alerts', headers: {authorization: 'Bearer ok'}});
      expect(query.mock.calls[1]![1]).toEqual([null]);
      for (const url of ['/api/alerts?state=bogus', '/api/alerts?state=open%27%20OR%20true', '/api/alerts?other=x']) {
        expect((await app.inject({method: 'GET', url, headers: {authorization: 'Bearer ok'}})).statusCode).toBe(400);
      }
      expect(query).toHaveBeenCalledTimes(2);
    } finally { await app.close(); }
  });

  it('acknowledges only an open alert without declaring it resolved', async () => {
    const query = vi.fn(async (_sql: string, args?: unknown[]) => args?.[0] === 'open'
      ? {rows: [{id: 'open', state: 'acked', resolvedAt: null}], rowCount: 1}
      : {rows: [], rowCount: 0});
    const app = Fastify();
    registerOperations(app, {query} as unknown as pg.Pool, async () => 'admin');
    try {
      const response = await app.inject({method: 'POST', url: '/api/alerts/open/ack', headers: {authorization: 'Bearer ok'}});
      expect(response.statusCode).toBe(200);
      expect(response.json().data).toEqual({id: 'open', state: 'acked', resolvedAt: null});
      expect(query.mock.calls[0]![0]).toMatch(/state='open'/);
      expect(query.mock.calls[0]![0]).not.toMatch(/resolved_at\s*=/);
      expect(query.mock.calls[0]![1]).toEqual(['open']);
      expect((await app.inject({method: 'POST', url: '/api/alerts/missing/ack', headers: {authorization: 'Bearer ok'}})).statusCode).toBe(404);
    } finally { await app.close(); }
  });
});
