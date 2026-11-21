import type { FastifyInstance } from 'fastify';
import { transactionOutcome } from './transaction-outcome.js';
import { conditionalSettingsSchema, settingsPatchSchema } from './schema.js';
import { SettingsConflict } from './repo.js';
import type { SettingsService } from './service.js';

/** Register PUT alongside the existing authenticated GET route. */
export function registerSettingsPut(app: FastifyInstance, service: SettingsService, authenticate: (token: string) => Promise<string | null>): void {
  const handle = async (request: import('fastify').FastifyRequest, reply: import('fastify').FastifyReply, conditional: boolean) => {
    const match = /^Bearer (.+)$/.exec(request.headers.authorization ?? '');
    if (!match || !await authenticate(match[1]!)) return reply.code(401).send({error:{code:'UNAUTHORIZED',message:'UNAUTHORIZED',details:null}});
    const parsed = conditional ? conditionalSettingsSchema.safeParse(request.body) : settingsPatchSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({error:{code:'BAD_REQUEST',message:'BAD_REQUEST',details:null}});
    try {
      if (conditional) {
        const { changes, expected } = conditionalSettingsSchema.parse(parsed.data);
        return { data: await service.update(changes, expected) };
      }
      return { data: await service.update(parsed.data) };
    }
    catch (error) {
      const outcome = transactionOutcome(error);
      if (outcome) {
        // A committed or possibly committed store update can reject before the
        // service schedules publish/device effects. These responses do not retry
        // or guarantee that those effects ran; reconciliation is still needed.
        const code = outcome === 'unknown' ? 'SETTINGS_WRITE_OUTCOME_UNKNOWN' : 'SETTINGS_WRITE_COMMITTED_EFFECTS_UNKNOWN';
        return reply.header('Cache-Control', 'no-store').code(503).send({error:{code,message:code,details:null}});
      }
      try {
        if (error instanceof SettingsConflict) return reply.header('Cache-Control', 'no-store').code(409).send({error:{code:'SETTINGS_CONFLICT',message:'SETTINGS_CONFLICT',details:null}});
        if (error instanceof Error && !(error instanceof AggregateError) && error.message === 'BAD_REQUEST') return reply.code(400).send({error:{code:'BAD_REQUEST',message:'BAD_REQUEST',details:null}});
      } catch { /* Malformed errors are internal failures, not validation. */ }
      return reply.code(500).send({error:{code:'INTERNAL_ERROR',message:'INTERNAL_ERROR',details:null}});
    }
  };
  app.put('/api/settings', (request, reply) => handle(request, reply, false));
  app.put('/api/settings/conditional', (request, reply) => handle(request, reply, true));
}
