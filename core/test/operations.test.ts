import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import type pg from 'pg';
import { registerOperations } from '../src/http/operations.js';
import { registerAudit } from '../src/http/audit.js';

const headers = { authorization: 'Bearer fixture-session' };
const hash = createHash('sha256').update('fixture-session').digest();
const url = '/api/alerts/fixture/ack';
const defer = () => { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { resolve, promise }; };

function fixture(options: { present?: boolean; active?: boolean; failAudit?: boolean; emptyAudit?: boolean;
  lostReply?: boolean; releaseFailed?: boolean; commitGate?: Promise<void>; loseAdmission?: boolean } = {}) {
  const persisted = { state: 'open', audits: 0 };
  let pending = { ...persisted };
  let admitted = true;
  const res = (rows: unknown[] = [], rowCount = rows.length, command = 'SELECT') => ({ rows, rowCount, command });
  const committed = defer();
  const release = vi.fn((discard?: boolean) => { if (!discard && options.releaseFailed) throw new Error('private fixture failure'); });
  const query = vi.fn(async (sql: string, args: unknown[] = []) => {
    if (sql === 'BEGIN') { pending = { ...persisted }; return res([], 0, sql); }
    if (sql === 'ROLLBACK') { pending = { ...persisted }; return res([], 0, sql); }
    if (sql === 'COMMIT') {
      committed.resolve(); await options.commitGate;
      Object.assign(persisted, pending);
      if (options.lostReply) throw new Error('private fixture failure');
      return res([], 0, sql);
    }
    if (sql.includes('FROM admin_session')) {
      expect(sql).toContain('token_hash=$1 AND admin_id=$2 AND expires_at>clock_timestamp() FOR SHARE');
      expect(args).toEqual([hash,'admin-fixture']);
      return options.active === false ? res() : res([{}]);
    }
    if (sql.startsWith('UPDATE alert SET')) {
      expect(sql).toContain("WHERE id=$1 AND state='open'");
      expect(sql).not.toMatch(/resolved_at\s*=/);
      expect(args).toEqual(['fixture']);
      if (pending.state !== 'open' || options.present === false) return res();
      pending.state = 'acked';
      return res([{ id:'fixture',state:'acked',resolvedAt:null }]);
    }
    if (sql.startsWith('INSERT INTO audit_log')) {
      expect(sql).toContain("'alert.ack','alert',$2,jsonb_build_object('actor',$3::text),$4");
      expect(args).toEqual([expect.stringMatching(/^aud_/),'fixture','admin-fixture','127.0.0.1']);
      expect(pending.state).toBe('acked');
      if (options.failAudit) throw new Error('private fixture failure');
      if (options.emptyAudit) return res();
      pending.audits++;
      if (options.loseAdmission) admitted = false;
      return res([],1);
    }
    throw new Error('Unexpected statement: ' + sql);
  });
  const connect = vi.fn(async () => ({ query, release }));
  const app = Fastify();
  const postAudit = vi.fn(async () => {});
  registerAudit(app, postAudit, vi.fn());
  registerOperations(app, { connect } as unknown as pg.Pool,
    async token => token === 'fixture-session' ? 'admin-fixture' : null,
    () => { if (!admitted) throw new Error('writer stopped'); });
  const post = () => app.inject({ method:'POST',url,headers });
  return { app, post, persisted, connect, release, query, postAudit, committed };
}

describe('atomic alert acknowledgement', () => {
  it('requires authentication and validates the identifier before acquiring a transaction', async () => {
    const f = fixture();
    try {
      expect((await f.app.inject({ method:'POST',url })).statusCode).toBe(401);
      expect((await f.app.inject({ method:'POST',url,headers:{authorization:'Bearer other'} })).statusCode).toBe(401);
      const response = await f.app.inject({ method:'POST',url:'/api/alerts/fixture%00/ack',headers });
      expect(response.statusCode).toBe(400);
      expect(f.connect).not.toHaveBeenCalled();
      expect(f.postAudit).not.toHaveBeenCalled();
    } finally { await f.app.close(); }
  });

  it('returns success only after the state change and audit commit; repeats do not audit', async () => {
    const gate = defer(), f = fixture({ commitGate:gate.promise });
    try {
      const sent = vi.fn(); const first = f.post().then(response => { sent(); return response; });
      await f.committed.promise;
      expect(f.persisted).toEqual({ state:'open',audits:0 });
      expect(sent).not.toHaveBeenCalled();
      gate.resolve();
      const response = await first;
      expect(response.statusCode).toBe(200);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.json()).toEqual({ data:{ id:'fixture',state:'acked',resolvedAt:null } });
      expect(f.persisted).toEqual({ state:'acked',audits:1 });
      expect((await f.post()).statusCode).toBe(404);
      expect(f.persisted.audits).toBe(1);
      expect(f.postAudit).not.toHaveBeenCalled();
    } finally { gate.resolve(); await f.app.close(); }
  });

  it.each([{ active:false,status:401 },{ present:false,status:404 }])('does not audit a denied or missing target', async ({ status, ...options }) => {
    const f = fixture(options);
    try {
      expect((await f.post()).statusCode).toBe(status);
      expect(f.persisted).toEqual({ state:'open',audits:0 });
      expect(f.query.mock.calls.some(([sql]) => sql.includes('INSERT INTO audit_log'))).toBe(false);
      if (status === 401) expect(f.query.mock.calls.some(([sql]) => sql.startsWith('UPDATE alert SET'))).toBe(false);
    } finally { await f.app.close(); }
  });

  it.each([{ failAudit:true },{ emptyAudit:true },{ loseAdmission:true }])('rolls back a failed audit or lost writer admission', async options => {
    const f = fixture(options);
    try {
      const response = await f.post();
      expect(response.statusCode).toBe(500);
      expect(response.json().error.code).toBe('INTERNAL');
      expect(response.body).not.toContain('private fixture');
      expect(f.query.mock.calls.at(-1)?.[0]).toBe('ROLLBACK');
      expect(f.persisted).toEqual({ state:'open',audits:0 });
      expect(f.release).toHaveBeenCalledWith(true);
    } finally { await f.app.close(); }
  });

  it.each([{ lostReply:true },{ releaseFailed:true }])('requires a separate readback on an uncertain response', async options => {
    const f = fixture(options);
    try {
      const response = await f.post();
      expect(response.statusCode).toBe(503);
      expect(response.json()).toEqual({ error:{ code:'TIMEOUT_UNKNOWN',message:'TIMEOUT_UNKNOWN',details:null } });
      expect(f.persisted).toEqual({ state:'acked',audits:1 });
      expect(f.connect).toHaveBeenCalledOnce();
      expect(f.postAudit).not.toHaveBeenCalled();
    } finally { await f.app.close(); }
  });
});
