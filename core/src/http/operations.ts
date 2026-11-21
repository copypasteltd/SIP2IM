import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { acknowledgeAlert, alertCursorMax, BadAlertCursor, listAlerts, validAlertId } from '../alerts/admin-repo.js';
import { tokenHash } from '../auth/service.js';
import { transactionOutcome } from '../settings/transaction-outcome.js';
import { listAudit } from './audit-list.js';
import { registerCommandList } from './command-list.js';

const error = (code: string) => ({ error: { code, message: code, details: null } });
const alertQuery = z.object({
  state: z.enum(['open', 'acked', 'resolved']).optional(),
  limit: z.string().min(1).refine(value => !/[^0-9]/.test(value)).transform(Number).pipe(z.number().int().min(1).max(100)).optional(),
  cursor: z.string().min(1).max(alertCursorMax).optional(),
}).strict();
const auditQuery = z.object({ limit: z.coerce.number().int().min(1).max(200).default(50), cursor: z.string().max(512).optional() }).strict();

export function registerOperations(app: FastifyInstance, pool: pg.Pool,
  authenticate: (token: string) => Promise<string | null>, assertAdmission: () => void = () => {}): void {
  registerCommandList(app, pool, authenticate);
  async function authorized(header: string | undefined) {
    const token = /^Bearer (.+)$/.exec(header ?? '')?.[1];
    if (!token) return null;
    const actor = await authenticate(token);
    return actor ? { actor, token } : null;
  }

  app.get('/api/alerts', async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (!await authorized(req.headers.authorization)) return reply.code(401).send(error('UNAUTHORIZED'));
    const parsed = alertQuery.safeParse(req.query);
    if (!parsed.success) return reply.code(400).send(error('BAD_REQUEST'));
    const { state, limit, cursor } = parsed.data;
    try { return await listAlerts(pool, state ?? null, { limit, cursor }); }
    catch (cause) {
      if (cause instanceof BadAlertCursor) return reply.code(400).send(error('BAD_REQUEST'));
      return reply.code(500).send(error('INTERNAL'));
    }
  });

  app.post<{ Params: { id: string } }>('/api/alerts/:id/ack', async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    const session = await authorized(req.headers.authorization);
    if (!session) return reply.code(401).send(error('UNAUTHORIZED'));
    if (!validAlertId(req.params.id)) return reply.code(400).send(error('BAD_REQUEST'));
    try {
      const result = await acknowledgeAlert(pool, req.params.id, {
        actor: session.actor, tokenHash: tokenHash(session.token), ip: req.ip,
      }, assertAdmission);
      if (result.status === 'acknowledged') return { data: result.data };
      if (result.status === 'unauthorized') return reply.code(401).send(error('UNAUTHORIZED'));
      return reply.code(404).send(error('NOT_FOUND'));
    } catch (cause) {
      // A lost COMMIT reply or failed release requires readback, not a blind repeat.
      if (transactionOutcome(cause)) return reply.code(503).send(error('TIMEOUT_UNKNOWN'));
      return reply.code(500).send(error('INTERNAL'));
    }
  });

  app.get('/api/audit-logs', async (req, reply) => {
    if (!await authorized(req.headers.authorization)) return reply.code(401).send(error('UNAUTHORIZED'));
    const parsed = auditQuery.safeParse(req.query);
    if (!parsed.success) return reply.code(400).send(error('BAD_REQUEST'));
    try { return await listAudit(pool, parsed.data.limit, parsed.data.cursor); }
    catch (cause) {
      if (cause instanceof Error && cause.message === 'BAD_CURSOR') return reply.code(400).send(error('BAD_REQUEST'));
      throw cause;
    }
  });
}
