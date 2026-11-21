import type { FastifyInstance, FastifyRequest } from 'fastify';
import { id } from '@voipgw/protocol';
import { z } from 'zod';
import { normalizeNumber } from '../sms/create.js';
import type { WebCalls } from '../calls/web-calls.js';
import { CallRequestError } from '../calls/web-call-store.js';
import { tokenHash } from '../auth/service.js';

const createBody = z.object({ simId: id('sim'), to: z.string().min(1).max(64) }).strict();
const dtmfBody = z.object({ digits: z.string().min(1).max(32).regex(/^[0-9*#]+$/) }).strict();
const empty = z.object({}).strict();
const errorBody = (code: string) => ({ error: { code, message: code, details: null } });

export function registerWebCallRoutes(app: FastifyInstance, options: {
  authenticate(token: string): Promise<string | null>;
  available(): string[];
  calls: Pick<WebCalls, 'create' | 'control'>;
}): void {
  async function owner(request: FastifyRequest): Promise<string | null> {
    const token = /^Bearer ([^\s]+)$/.exec(request.headers.authorization ?? '')?.[1];
    return token && await options.authenticate(token) ? tokenHash(token).toString('hex') : null;
  }

  app.get('/api/calls/availability', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (!await owner(request)) return reply.code(401).send(errorBody('UNAUTHORIZED'));
    if (!empty.safeParse(request.query).success) return reply.code(400).send(errorBody('BAD_REQUEST'));
    return { data: { deviceIds: options.available() } };
  });

  app.post('/api/calls', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const actor = await owner(request);
    if (!actor) return reply.code(401).send(errorBody('UNAUTHORIZED'));
    const key = request.headers['idempotency-key'];
    if (typeof key !== 'string' || !key.trim()) return reply.code(400).send(errorBody('IDEMPOTENCY_KEY_REQUIRED'));
    if (key.length > 256 || key.includes('\0')) return reply.code(400).send(errorBody('BAD_REQUEST'));
    const input = createBody.safeParse(request.body);
    if (!input.success) return reply.code(400).send(errorBody('BAD_REQUEST'));
    const number = normalizeNumber(input.data.to);
    if (!number) return reply.code(400).send(errorBody('NUMBER_INVALID'));
    try {
      return { data: await options.calls.create({ key, simId: input.data.simId, to: number.number, peerKind: number.kind }, actor) };
    } catch (cause) {
      const fault = cause instanceof CallRequestError ? cause : new CallRequestError('TIMEOUT_UNKNOWN', 504);
      return reply.code(fault.status).send(errorBody(fault.code));
    }
  });

  for (const type of ['call.hangup', 'call.dtmf'] as const) {
    const suffix = type === 'call.hangup' ? 'hangup' : 'dtmf';
    app.post<{ Params: { id: string } }>(`/api/calls/:id/${suffix}`, async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      const actor = await owner(request);
      if (!actor) return reply.code(401).send(errorBody('UNAUTHORIZED'));
      if (!id('ses').safeParse(request.params.id).success) return reply.code(400).send(errorBody('BAD_REQUEST'));
      const digits = type === 'call.dtmf' ? dtmfBody.safeParse(request.body) : undefined;
      if ((digits && !digits.success) || (type === 'call.hangup' && !empty.safeParse(request.body ?? {}).success)) {
        return reply.code(400).send(errorBody('BAD_REQUEST'));
      }
      try {
        await options.calls.control(request.params.id, actor, type, digits?.data?.digits);
        return { data: {} };
      } catch (cause) {
        const fault = cause instanceof CallRequestError ? cause : new CallRequestError('TIMEOUT_UNKNOWN', 504);
        return reply.code(fault.status).send(errorBody(fault.code));
      }
    });
  }
}
