import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { tokenHash } from '../auth/service.js';
import type { BindInput, BindResult, BindV2Input, BindV2Result, BindingCancellation } from '../devices/binding.js';

export interface BindingHttpDeps {
  bind(input: BindInput): Promise<BindResult>;
  bindV2?(input: BindV2Input, credentialHash: Buffer): Promise<BindV2Result>;
  createCode(): Promise<{ code: string; expiresAt: number; recordId?: string }>;
  listBindingCodes?(cursor?: string): Promise<{ data: unknown[]; nextCursor: string | null }>;
  cancelBindingCode?(id: string): Promise<BindingCancellation | null>;
  publicHost: string;
  port: number;
}

const bindSchema = z.object({
  code: z.string().regex(/^\d{6}$/), manufacturer: z.string(), model: z.string(),
  apiLevel: z.number().positive().refine(Number.isInteger), apkVersion: z.string(),
  apkCode: z.number().refine(Number.isInteger), locale: z.string(),
});

function canonicalBase64Url(value: string, bytes: number): boolean {
  if (value.length !== Math.ceil(bytes * 8 / 6) || !/^[A-Za-z0-9_-]+$/.test(value)) return false;
  const decoded = Buffer.from(value, 'base64url');
  return decoded.length === bytes && decoded.toString('base64url') === value;
}

// Reject inputs which would be lossy in PostgreSQL UTF-8 or include a NUL.
const text = (max: number) => z.string().max(max).refine(value => !/[\u0000\uD800-\uDFFF]/u.test(value));
const bindV2Schema = z.object({
  protocolVersion: z.literal(2),
  attemptId: z.string().refine(value => canonicalBase64Url(value, 16)),
  code: z.string().length(6).regex(/^[0-9]{6}$/),
  manufacturer: text(128), model: text(128), apkVersion: text(64), locale: text(64),
  apiLevel: z.number().int().min(1).max(2147483647),
  apkCode: z.number().int().min(0).max(2147483647),
}).strict();

const recordIdSchema = z.string().length(36).regex(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
const emptyObject = z.object({}).strict();
const error = (code: string) => ({ error: { code, message: code, details: null } });
const reject = (status: number, code: string) => ({ status, body: error(code) });
const success = (data: unknown) => ({ status: 200, body: { data } });
const rateLimited = () => reject(429, 'BINDING_RATE_LIMITED');
const send = (reply: FastifyReply, result: { status: number; body: unknown }) => reply.code(result.status).send(result.body);
const bindFailure = (code: 'BINDING_INVALID' | 'BINDING_EXPIRED') => reject(code === 'BINDING_EXPIRED' ? 410 : 400, code);

const windowMs = 60_000;
const failureLimit = 10;
const v2Limit = 60;

type RateState = { failures: number[]; v2Attempts: number[]; tail?: Promise<void>; pendingV2: number };

function bindingLimiter() {
  const states = new Map<string, RateState>();
  let lastSweep = 0;
  return async (ip: string, v2: boolean, execute: () => Promise<{ status: number; body: unknown }>) => {
    const enteredAt = Date.now();
    if (enteredAt - lastSweep >= windowMs) {
      for (const [key, state] of states) {
        if (!state.tail && (state.failures.at(-1) ?? 0) <= enteredAt - windowMs
          && (state.v2Attempts.at(-1) ?? 0) <= enteredAt - windowMs) states.delete(key);
      }
      lastSweep = enteredAt;
    }
    const state: RateState = states.get(ip) ?? { failures: [], v2Attempts: [], pendingV2: 0 };
    states.set(ip, state);
    if (v2 && state.pendingV2 >= v2Limit) return rateLimited();
    if (v2) state.pendingV2++;
    const previous = state.tail;
    let unlock!: () => void;
    const tail = new Promise<void>(resolve => { unlock = resolve; });
    state.tail = tail;
    await previous;
    try {
      const now = Date.now();
      state.failures = state.failures.filter(time => time > now - windowMs);
      state.v2Attempts = state.v2Attempts.filter(time => time > now - windowMs);
      if (state.failures.length >= failureLimit || (v2 && state.v2Attempts.length >= v2Limit)) return rateLimited();
      if (v2) state.v2Attempts.push(now);
      const result = await execute();
      if (result.status === 400 || result.status === 410 || (v2 && result.status === 500)) state.failures.push(now);
      return result;
    } finally {
      if (v2) state.pendingV2--;
      unlock();
      if (state.tail === tail) {
        delete state.tail;
        if (state.failures.length === 0 && state.v2Attempts.length === 0) states.delete(ip);
      }
    }
  };
}

const parseV2Credential = (authorization: string | undefined, rawHeaders: string[]): Buffer | null => {
  const count = rawHeaders.filter((name, i) => i % 2 === 0 && name.toLowerCase() === 'authorization').length;
  if (count !== 1 || !authorization?.startsWith('Bearer ')) return null;
  const bearer = authorization.slice(7);
  return canonicalBase64Url(bearer, 32) ? tokenHash(bearer) : null;
};

const parserErrors = new Set([
  'FST_ERR_CTP_INVALID_JSON_BODY', 'FST_ERR_CTP_EMPTY_JSON_BODY', 'FST_ERR_CTP_INVALID_MEDIA_TYPE',
  'FST_ERR_CTP_INVALID_CONTENT_LENGTH', 'FST_ERR_CTP_BODY_TOO_LARGE',
]);

export function registerBindingRoutes(
  app: FastifyInstance,
  deps: BindingHttpDeps,
  requireAuth: (authorization: string | undefined) => Promise<unknown>,
): void {
  const limited = bindingLimiter();
  app.post('/api/device/bind', async (req, reply) => send(reply, await limited(req.ip, false, async () => {
    const parsed = bindSchema.safeParse(req.body);
    if (!parsed.success) return reject(400, 'BAD_REQUEST');
    const result = await deps.bind(parsed.data);
    return 'error' in result ? bindFailure(result.error) : success(result);
  })));

  const noStore = async (_req: unknown, reply: FastifyReply) => { reply.header('Cache-Control', 'no-store'); };
  const bindV2 = deps.bindV2;
  if (bindV2) app.post('/api/device/bind-v2', {
    onRequest: noStore,
    bodyLimit: 4096,
    errorHandler: async (err, req, reply) => {
      // Produce a fixed response even when parsing fails before the handler.
      reply.header('Cache-Control', 'no-store');
      if (!err.code || !parserErrors.has(err.code)) return send(reply, reject(500, 'INTERNAL'));
      return send(reply, await limited(req.ip, true, async () => reject(400, 'BAD_REQUEST')));
    },
  }, async (req, reply) => send(reply, await limited(req.ip, true, async () => {
    const parsed = bindV2Schema.safeParse(req.body);
    const credentialHash = parseV2Credential(req.headers.authorization, req.raw.rawHeaders);
    if (!parsed.success || !credentialHash || !emptyObject.safeParse(req.query).success) return reject(400, 'BAD_REQUEST');
    try {
      const result = await bindV2(parsed.data, credentialHash);
      if ('error' in result) return bindFailure(result.error);
      return success({ protocolVersion: result.protocolVersion, attemptId: result.attemptId, deviceId: result.deviceId });
    } catch {
      // Database and driver errors can contain bound values. Keep them private.
      return reject(500, 'INTERNAL');
    }
  })));

  const codes = '/api/devices/binding-codes';
  const qrPayload = (code: string) => 'voipgw://bind?' + new URLSearchParams({ host: deps.publicHost, port: String(deps.port), code });
  app.post(codes, { onRequest: noStore }, async (req, reply) => {
    if (!await requireAuth(req.headers.authorization)) return send(reply, reject(401, 'UNAUTHORIZED'));
    const { code, expiresAt } = await deps.createCode();
    return { data: { code, expiresAt, qrPayload: qrPayload(code) } };
  });

  const { listBindingCodes, cancelBindingCode } = deps;
  if (!listBindingCodes || !cancelBindingCode) return;

  app.post(codes + '/v2', { onRequest: noStore }, async (req, reply) => {
    if (!await requireAuth(req.headers.authorization)) return send(reply, reject(401, 'UNAUTHORIZED'));
    if (!emptyObject.safeParse(req.query).success || !emptyObject.safeParse(req.body ?? {}).success) {
      return send(reply, reject(400, 'BAD_REQUEST'));
    }
    const { code, expiresAt, recordId } = await deps.createCode();
    if (!recordId || !recordIdSchema.safeParse(recordId).success) return send(reply, reject(500, 'INTERNAL'));
    return { data: { recordId, code, expiresAt, qrPayload: qrPayload(code) } };
  });

  app.get(codes, { onRequest: noStore }, async (req, reply) => {
    if (!await requireAuth(req.headers.authorization)) return send(reply, reject(401, 'UNAUTHORIZED'));
    const query = z.object({ cursor: recordIdSchema.optional() }).strict().safeParse(req.query);
    if (!query.success) return send(reply, reject(400, 'BAD_REQUEST'));
    return listBindingCodes(query.data.cursor);
  });

  app.post<{ Params: { id: string } }>(codes + '/:id/cancel', { onRequest: noStore }, async (req, reply) => {
    if (!await requireAuth(req.headers.authorization)) return send(reply, reject(401, 'UNAUTHORIZED'));
    if (!recordIdSchema.safeParse(req.params.id).success || !emptyObject.safeParse(req.query).success
      || !emptyObject.safeParse(req.body ?? {}).success) return send(reply, reject(400, 'BAD_REQUEST'));
    const result = await cancelBindingCode(req.params.id);
    if (!result) return send(reply, reject(404, 'NOT_FOUND'));
    if (result.teardownPending) return send(reply, reject(500, 'INTERNAL'));
    return { data: { recordId: req.params.id, deviceId: result.deviceId } };
  });
}
