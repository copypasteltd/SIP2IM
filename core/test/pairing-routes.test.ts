import { createHash } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import { registerChannelRoutes } from '../src/channels/routes.js';
import { PairingService } from '../src/channels/pairing-service.js';
import type { SettingsService } from '../src/settings/service.js';

it('issues only to an authenticated caller for a valid platform using the injected service', async () => {
  const issue = vi.fn(async (_platform: 'qq' | 'telegram', _hash: Buffer) => 123456);
  const service = new PairingService({ issue, redeem: async () => ({status:'invalid'}) });
  const app = Fastify();
  registerChannelRoutes(app, {} as SettingsService, {pairedUser:async()=>null,revokePairedUser:async()=>{}}, async token=>token==='ok'?'admin':null, service);
  try {
    for (const authorization of [undefined, 'Bearer wrong', 'Basic ok']) {
      const headers = authorization ? { authorization } : {};
      expect((await app.inject({method:'POST',url:'/api/channels/qq/pairing-code',headers})).statusCode).toBe(401);
    }
    expect((await app.inject({method:'POST',url:'/api/channels/other/pairing-code',headers:{authorization:'Bearer ok'}})).statusCode).toBe(400);
    expect(issue).not.toHaveBeenCalled();
    for (const platform of ['qq', 'telegram'] as const) {
      const response = await app.inject({method:'POST',url:`/api/channels/${platform}/pairing-code`,headers:{authorization:'Bearer ok'}});
      expect(response.statusCode).toBe(200);
      expect(response.headers['cache-control']).toBe('no-store');
      const {code, expiresAt} = response.json().data;
      expect(code).toMatch(/^[0-9]{8}$/);
      expect(expiresAt).toBe(123456);
      expect(issue).toHaveBeenLastCalledWith(platform, createHash('sha256').update(code).digest());
    }
  } finally { await app.close(); }
});
