import { randomBytes, randomInt, randomUUID } from 'node:crypto';
import type { OutgoingHttpHeaders } from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import { tokenHash } from '../src/auth/service.js';
import { createServer, type HttpDeps } from '../src/http/server.js';
import type { BindInput } from '../src/devices/binding.js';

function fixture() {
  const bearer = randomBytes(32).toString('base64url');
  const admin = randomBytes(32).toString('base64url');
  const input = {
    protocolVersion: 2 as const, attemptId: randomBytes(16).toString('base64url'),
    code: randomInt(1_000_000).toString().padStart(6, '0'),
    manufacturer: 'Maker', model: 'Phone 📱', apiLevel: 19, apkVersion: '1.2', apkCode: 3, locale: 'en',
  };
  return {
    bearer, input, admin, recordId: randomUUID(),
    headers: { authorization: 'Bearer ' + bearer, 'cache-control': 'no-store' },
    adminHeaders: { authorization: 'Bearer ' + admin },
  };
}

const page = { data: [], nextCursor: null };
const defaults = (overrides: Partial<HttpDeps> = {}): HttpDeps => ({
  login: async () => null, authenticate: async () => null, admin: async () => null,
  logout: async () => {}, changePassword: async () => false, setLocale: async () => {},
  createCode: async () => ({ code: fixture().input.code, expiresAt: 1 }),
  bind: async () => ({ error: 'BINDING_INVALID' }), health: async () => true,
  getSettings: async () => ({}), listChannels: async () => [], listCalls: async () => page,
  listSms: async () => page, listThreads: async () => page, createSms: async () => null,
  listDevices: async () => page, deviceDetail: async () => null, probeDevice: async () => 'ok',
  revokeDevice: async () => false, setSimNumber: async () => null, reviewSim: async () => null,
  updateDevice: async () => null, publicHost: 'example.test', port: 47860, ...overrides,
});

function nonCanonical(input: string) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  return input.slice(0, -1) + alphabet[alphabet.indexOf(input.at(-1)!) ^ 1];
}

const v2 = '/api/device/bind-v2';
const v1 = '/api/device/bind';
const codes = '/api/devices/binding-codes';

async function withApp<T>(deps: HttpDeps, run: (app: ReturnType<typeof createServer>) => Promise<T>) {
  const app = createServer(deps);
  try { return await run(app); } finally { await app.close(); }
}

describe('POST /api/device/bind-v2', () => {
  it('passes only the credential hash to the repository and projects the exact response', async () => {
    const f = fixture();
    const bindV2 = vi.fn<NonNullable<HttpDeps['bindV2']>>().mockImplementation(async () => ({
      protocolVersion: 2, attemptId: f.input.attemptId, deviceId: 'dev_fixture', extraneous: f.bearer,
    }));
    const v1Bind = vi.fn<HttpDeps['bind']>();
    await withApp(defaults({ bindV2, bind: v1Bind }), async app => {
      const response = await app.inject({ method: 'POST', url: v2, payload: f.input, headers: f.headers });
      expect(response.statusCode).toBe(200);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.json()).toEqual({ data: { protocolVersion: 2, attemptId: f.input.attemptId, deviceId: 'dev_fixture' } });
      expect(bindV2).toHaveBeenCalledExactlyOnceWith(f.input, tokenHash(f.bearer));
      expect(v1Bind).toHaveBeenCalledTimes(0);
    });
  });

  it('rejects malformed headers, ambiguity and out-of-range metadata before persistence', async () => {
    const f = fixture();
    const bindV2 = vi.fn<NonNullable<HttpDeps['bindV2']>>();
    await withApp(defaults({ bindV2 }), async app => {
      const malformed: { headers?: OutgoingHttpHeaders; payload?: object | string; url?: string }[] = [
        { headers: {} },
        { headers: { authorization: 'Bearer ' + nonCanonical(f.bearer) } },
        { headers: { authorization: 'Bearer ' + f.bearer + '=' } },
        { headers: { authorization: 'Bearer ' + randomBytes(31).toString('base64url') } },
        // Injection supports a duplicate raw header, which Node types as a single string.
        { headers: { authorization: ['Bearer ' + f.bearer, 'Bearer ' + f.bearer] as unknown as string } },
        { payload: { ...f.input, protocolVersion: 1 } },
        { payload: { ...f.input, attemptId: nonCanonical(f.input.attemptId) } },
        { payload: { ...f.input, attemptId: f.input.attemptId + '=' } },
        { payload: { ...f.input, apkCode: 2147483648 } },
        { payload: { ...f.input, apiLevel: 1.5 } },
        { payload: { ...f.input, model: 'x'.repeat(129) } },
        { payload: { ...f.input, model: '\ud800' } },
        { payload: { ...f.input, model: '\0' } },
        { payload: { ...f.input, token: f.bearer } },
        { payload: { ...f.input, code: f.input.code + '\n' } },
        { url: v2 + '?unused=1' },
        { payload: '{', headers: { ...f.headers, 'content-type': 'application/json' } },
        { payload: { ...f.input, model: 'x'.repeat(5000) } },
      ];
      for (const [index, change] of malformed.entries()) {
        const response = await app.inject({ method: 'POST', url: v2, headers: f.headers, payload: f.input,
          remoteAddress: '192.0.2.' + (index + 1), ...change });
        expect(response.statusCode, 'case ' + (index + 1)).toBe(400);
        expect(response.headers['cache-control']).toBe('no-store');
        expect(response.json()).toEqual({ error: { code: 'BAD_REQUEST', message: 'BAD_REQUEST', details: null } });
      }
      expect(bindV2).toHaveBeenCalledTimes(0);
    });
  });

  it('uses the safe error vocabulary for expired requests and unexpected transaction failures', async () => {
    const f = fixture();
    const bindV2 = vi.fn<NonNullable<HttpDeps['bindV2']>>()
      .mockResolvedValueOnce({ error: 'BINDING_EXPIRED' })
      .mockResolvedValueOnce({ error: 'BINDING_INVALID' })
      .mockRejectedValueOnce(new Error(f.bearer + f.input.code));
    await withApp(defaults({ bindV2 }), async app => {
      for (const [status, code] of [[410, 'BINDING_EXPIRED'], [400, 'BINDING_INVALID'], [500, 'INTERNAL']] as const) {
        const response = await app.inject({ method: 'POST', url: v2, payload: f.input, headers: f.headers });
        expect(response.statusCode).toBe(status);
        expect(response.headers['cache-control']).toBe('no-store');
        expect(response.json()).toEqual({ error: { code, message: code, details: null } });
      }
    });
  });

  it('counts v1 and v2 failures together under concurrent requests', async () => {
    const f = fixture();
    const { code, manufacturer, model, apiLevel, apkVersion, apkCode, locale } = f.input;
    const legacyPayload: BindInput = { code, manufacturer, model, apiLevel, apkVersion, apkCode, locale };
    const bind = vi.fn<HttpDeps['bind']>().mockResolvedValue({ error: 'BINDING_INVALID' });
    const bindV2 = vi.fn<NonNullable<HttpDeps['bindV2']>>().mockResolvedValue({ error: 'BINDING_INVALID' });
    await withApp(defaults({ bind, bindV2 }), async app => {
      const responses = await Promise.all(Array.from({ length: 12 }, (_, i) => app.inject(i % 2 ?
        { method: 'POST', url: v2, payload: f.input, headers: f.headers } :
        { method: 'POST', url: v1, payload: legacyPayload })));
      expect(bind.mock.calls.length + bindV2.mock.calls.length).toBe(10);
      expect(responses.filter(r => r.statusCode === 400)).toHaveLength(10);
      for (const response of responses.filter(r => r.statusCode === 429)) {
        expect(response.json().error.code).toBe('BINDING_RATE_LIMITED');
      }
      expect(responses.filter(r => r.statusCode === 429)).toHaveLength(2);
    });
  });

  it('bounds successful v2 traffic per IP without capping v1 successes', async () => {
    const f = fixture();
    const legacyToken = randomBytes(32).toString('base64url');
    const bindV2 = vi.fn<NonNullable<HttpDeps['bindV2']>>().mockResolvedValue({ protocolVersion: 2, attemptId: f.input.attemptId, deviceId: 'dev_fixture' });
    const bind = vi.fn<HttpDeps['bind']>().mockResolvedValue({ deviceId: 'dev_legacy', token: legacyToken });
    await withApp(defaults({ bindV2, bind }), async app => {
      const responses = await Promise.all(Array.from({ length: 62 }, () =>
        app.inject({ method: 'POST', url: v2, payload: f.input, headers: f.headers })));
      expect(bindV2).toHaveBeenCalledTimes(60);
      expect(responses.filter(r => r.statusCode === 200)).toHaveLength(60);
      expect(responses.filter(r => r.statusCode === 429)).toHaveLength(2);
      const independent = await app.inject({ method: 'POST', url: v2, payload: f.input, headers: f.headers, remoteAddress: '192.0.2.1' });
      expect(independent.statusCode).toBe(200);
      const legacy = await app.inject({ method: 'POST', url: v1, payload: f.input });
      expect(legacy.json()).toEqual({ data: { deviceId: 'dev_legacy', token: legacyToken } });
    });
  });
});

it('restricts record ID issuance, inventory and cancellation to administrators', async () => {
  const f = fixture();
  const expiresAt = 10;
  const createCode = vi.fn<HttpDeps['createCode']>().mockResolvedValue({ code: f.input.code, expiresAt, recordId: f.recordId });
  const inventory = { data: [{ recordId: f.recordId, expiresAt }], nextCursor: null };
  const listBindingCodes = vi.fn<NonNullable<HttpDeps['listBindingCodes']>>().mockResolvedValue(inventory);
  const cancelBindingCode = vi.fn<NonNullable<HttpDeps['cancelBindingCode']>>()
    .mockResolvedValueOnce({ deviceId: 'dev_fixture', teardownPending: true })
    .mockResolvedValueOnce({ deviceId: 'dev_fixture', teardownPending: false })
    .mockResolvedValueOnce(null);
  const authenticate = async (token: string) => token === f.admin ? 'admin' : null;
  await withApp(defaults({ authenticate, createCode, listBindingCodes, cancelBindingCode }), async app => {
    const cancelUrl = codes + '/' + f.recordId + '/cancel';
    for (const [method, url] of [['POST', codes + '/v2'], ['GET', codes], ['POST', cancelUrl]] as const) {
      const unauthorized = await app.inject({ method, url, headers: f.headers });
      expect(unauthorized.statusCode).toBe(401);
      expect(unauthorized.headers['cache-control']).toBe('no-store');
    }
    expect(createCode).toHaveBeenCalledTimes(0);
    expect(listBindingCodes).toHaveBeenCalledTimes(0);
    expect(cancelBindingCode).toHaveBeenCalledTimes(0);

    const legacy = await app.inject({ method: 'POST', url: codes, headers: f.adminHeaders });
    const fresh = await app.inject({ method: 'POST', url: codes + '/v2', headers: f.adminHeaders });
    expect(Object.keys(legacy.json().data).sort()).toEqual(['code', 'expiresAt', 'qrPayload']);
    expect(fresh.json().data).toEqual({ ...legacy.json().data, recordId: f.recordId });
    const list = await app.inject({ method: 'GET', url: codes + '?cursor=' + f.recordId, headers: f.adminHeaders });
    expect(list.json()).toEqual(inventory);
    expect(listBindingCodes).toHaveBeenCalledExactlyOnceWith(f.recordId);

    const invalid = await app.inject({ method: 'POST', url: codes + '/' + f.input.code + '/cancel', headers: f.adminHeaders });
    expect(invalid.statusCode).toBe(400);
    expect(cancelBindingCode).toHaveBeenCalledTimes(0);
    const pending = await app.inject({ method: 'POST', url: cancelUrl, headers: f.adminHeaders });
    expect(pending.statusCode).toBe(500);
    expect(pending.json().error.code).toBe('INTERNAL');
    const cancelled = await app.inject({ method: 'POST', url: cancelUrl, headers: f.adminHeaders });
    expect(cancelled.json()).toEqual({ data: { recordId: f.recordId, deviceId: 'dev_fixture' } });
    expect(cancelBindingCode).toHaveBeenNthCalledWith(1, f.recordId);
    expect(cancelBindingCode).toHaveBeenNthCalledWith(2, f.recordId);
    expect((await app.inject({ method: 'POST', url: codes + '/' + randomUUID() + '/cancel', headers: f.adminHeaders })).statusCode).toBe(404);
  });
});
