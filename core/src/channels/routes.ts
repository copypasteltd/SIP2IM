import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { SettingsService } from '../settings/service.js';
import { transactionOutcome } from '../settings/transaction-outcome.js';

const error = (code: string) => ({ error: { code, message: code, details: null } });
const platform = z.enum(['qq', 'telegram']);
export interface ChannelManagement {
  pairedUser(platform: 'qq' | 'telegram'): Promise<unknown | null>;
  revokePairedUser(platform: 'qq' | 'telegram'): Promise<void>;
}

export interface PairingIssuer {
  issue(platform: 'qq' | 'telegram'): Promise<{ code: string; expiresAt: number }>;
}

export function registerChannelRoutes(app: FastifyInstance, settings: SettingsService, channels: ChannelManagement, authenticate: (token: string) => Promise<string | null>, pairing?: PairingIssuer): void {
  async function authorized(header: string | undefined): Promise<boolean> {
    const match = /^Bearer (.+)$/.exec(header ?? '');
    return !!match && !!await authenticate(match[1]!);
  }
  app.put('/api/channels/inbound', async (req, reply) => {
    if (!await authorized(req.headers.authorization)) return reply.code(401).send(error('UNAUTHORIZED'));
    const input = z.object({ platform }).strict().safeParse(req.body);
    if (!input.success) return reply.code(400).send(error('BAD_REQUEST'));
    try {
      return { data: await settings.update({ inboundPlatform: input.data.platform }) };
    } catch (cause) {
      const outcome = transactionOutcome(cause);
      if (outcome) {
        const code = outcome === 'unknown' ? 'SETTINGS_WRITE_OUTCOME_UNKNOWN' : 'SETTINGS_WRITE_COMMITTED_EFFECTS_UNKNOWN';
        return reply.header('Cache-Control', 'no-store').code(503).send(error(code));
      }
      return reply.code(500).send(error('INTERNAL_ERROR'));
    }
  });
  app.get<{Params:{platform:string}}>('/api/channels/:platform/paired-user', async (req, reply) => {
    if (!await authorized(req.headers.authorization)) return reply.code(401).send(error('UNAUTHORIZED'));
    const parsed = platform.safeParse(req.params.platform);
    if (!parsed.success) return reply.code(400).send(error('BAD_REQUEST'));
    return { data: await channels.pairedUser(parsed.data) };
  });
  app.delete<{Params:{platform:string}}>('/api/channels/:platform/paired-user', async (req, reply) => {
    if (!await authorized(req.headers.authorization)) return reply.code(401).send(error('UNAUTHORIZED'));
    const parsed = platform.safeParse(req.params.platform);
    if (!parsed.success) return reply.code(400).send(error('BAD_REQUEST'));
    await channels.revokePairedUser(parsed.data);
    return { data: {} };
  });
  app.post<{Params:{platform:string}}>('/api/channels/:platform/pairing-code', async (req, reply) => {
    if (!await authorized(req.headers.authorization)) return reply.code(401).send(error('UNAUTHORIZED'));
    const parsed = platform.safeParse(req.params.platform);
    if (!parsed.success) return reply.code(400).send(error('BAD_REQUEST'));
    if (!pairing) return reply.code(409).send(error('CAPABILITY_UNSUPPORTED'));
    reply.header('Cache-Control', 'no-store');
    return { data: await pairing.issue(parsed.data) };
  });
  for (const [method, url] of [['PUT', '/api/channels/:platform/voice-verified']] as const) {
    app.route({ method, url, handler: async (req, reply) => {
      if (!await authorized(req.headers.authorization)) return reply.code(401).send(error('UNAUTHORIZED'));
      if (!platform.safeParse((req.params as {platform:string}).platform).success) return reply.code(400).send(error('BAD_REQUEST'));
      return reply.code(409).send(error('CAPABILITY_UNSUPPORTED'));
    }});
  }
}
