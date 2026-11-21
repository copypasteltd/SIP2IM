import { describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { TransactionCommitUnknown, TransactionReleaseFailed } from '../src/db/pool.js';
import { registerSettingsPut } from '../src/settings/routes.js';
import type { SettingsService } from '../src/settings/service.js';

type Handler = (request: {headers: {authorization?: string}; body: unknown}, reply: {code: (status: number) => unknown; send: (body: unknown) => unknown}) => Promise<unknown>;
function fixture(failure: unknown) {
  const handlers = new Map<string, Handler>();
  const app = { put: (path: string, fn: Handler) => { handlers.set(path, fn); } };
  const update = vi.fn(async () => { throw failure; });
  registerSettingsPut(app as unknown as FastifyInstance, { update } as unknown as SettingsService, async () => 'admin');
  let status = 200;
  const headers: Record<string, string> = {};
  const reply = { header(name: string, value: string) { headers[name] = value; return this; }, code(value: number) { status = value; return this; }, send(body: unknown) { return body; } };
  return { update, headers, invoke: async (body: unknown = {heartbeatSec: 40}) => {
    const handler = handlers.get('/api/settings');
    if (!handler) throw new Error('Missing legacy settings route');
    const result = await handler({headers: {authorization: 'Bearer token'}, body}, reply);
    return {status, result};
  }};
}
const response = (code: string) => ({error:{code,message:code,details:null}});

describe('settings PUT failure classification', () => {
  it.each([
    [new TransactionCommitUnknown(new Error('secret DB credential')), 'SETTINGS_WRITE_OUTCOME_UNKNOWN'],
    [new AggregateError([new Error('secret cleanup'), new AggregateError([new TransactionCommitUnknown('secret')])]), 'SETTINGS_WRITE_OUTCOME_UNKNOWN'],
    [new TransactionReleaseFailed(new Error('secret DB credential')), 'SETTINGS_WRITE_COMMITTED_EFFECTS_UNKNOWN'],
    [new AggregateError([new AggregateError([new TransactionReleaseFailed('secret')])]), 'SETTINGS_WRITE_COMMITTED_EFFECTS_UNKNOWN'],
    [new AggregateError([new TransactionReleaseFailed('secret'), new TransactionCommitUnknown('secret')]), 'SETTINGS_WRITE_OUTCOME_UNKNOWN'],
  ])('classifies transaction outcomes without exposing details or retrying', async (failure, code) => {
    const f = fixture(failure);
    expect(await f.invoke()).toEqual({status:503,result:response(code)});
    expect(f.update).toHaveBeenCalledTimes(1);
    expect(f.headers['Cache-Control']).toBe('no-store');
  });
  it('handles cyclic aggregate errors safely', async () => {
    const failure = new AggregateError([]);
    failure.errors.push(failure, new TransactionCommitUnknown('secret'));
    expect(await fixture(failure).invoke()).toEqual({status:503,result:response('SETTINGS_WRITE_OUTCOME_UNKNOWN')});
  });
  it('treats malformed and oversized aggregates as unknown without leaking errors', async () => {
    const malformed = new AggregateError([]);
    Object.defineProperty(malformed, 'errors', {get() { throw new Error('secret'); }});
    for (const failure of [malformed, new AggregateError(Array.from({length: 1025}, (_, i) => i))]) {
      const f = fixture(failure);
      expect(await f.invoke()).toEqual({status:503,result:response('SETTINGS_WRITE_OUTCOME_UNKNOWN')});
      expect(f.update).toHaveBeenCalledTimes(1);
    }
  });
  it('captures a fixed aggregate length even when a proxy reports growth', async () => {
    let lengthReads = 0;
    const entries = new Proxy([new TransactionCommitUnknown('secret')], {
      get(target, key, receiver) {
        if (key === 'length') return ++lengthReads === 1 ? 1 : 10000000;
        return Reflect.get(target, key, receiver);
      },
    });
    const failure = new AggregateError([]);
    Object.defineProperty(failure, 'errors', {value: entries});
    expect(await fixture(failure).invoke()).toEqual({status:503,result:response('SETTINGS_WRITE_OUTCOME_UNKNOWN')});
    expect(lengthReads).toBe(1);
  });
  it('retains BAD_REQUEST only for direct known validation and rejects invalid bodies before update', async () => {
    const validation = fixture(new Error('BAD_REQUEST'));
    expect(await validation.invoke()).toEqual({status:400,result:response('BAD_REQUEST')});
    const invalid = fixture(new Error('secret'));
    expect(await invalid.invoke({heartbeatSec:0})).toEqual({status:400,result:response('BAD_REQUEST')});
    expect(invalid.update).not.toHaveBeenCalled();
  });
  const hostileMessage = new Error();
  Object.defineProperty(hostileMessage, 'message', {get() { throw new Error('secret'); }});
  it.each([hostileMessage, new Error('secret database details'), new AggregateError([new Error('BAD_REQUEST'), new Error('secret cleanup')]), 'secret'])('sanitizes other errors', async failure => {
    const f = fixture(failure);
    expect(await f.invoke()).toEqual({status:500,result:response('INTERNAL_ERROR')});
    expect(f.update).toHaveBeenCalledTimes(1);
  });
});
