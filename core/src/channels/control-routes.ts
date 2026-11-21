import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AdapterLoginStep, AdapterPlatform } from './adapter-manager.js';
import { loginOperationIdPattern, type PersistentLoginOperations } from './login-persistent.js';

const platform = z.enum(['qq', 'telegram']);
const challengeId = z.string().length(36).regex(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
const submit = z.object({step:z.enum(['qr','phone','code','password']),value:z.string().min(1).max(4096),challengeId}).strict();
const empty = z.object({}).strict();
const operationId = z.string().regex(loginOperationIdPattern);
const release = z.object({operationId,outcome:z.enum(['ack','offline','invalid'])}).strict();
const error = (code:string) => ({error:{code,message:code,details:null}});
const prefix = '/api/channels/:platform';
const STEP_AUTH_CHANGED = new Error('Login step authorization changed');
const noStore = {onRequest: async (_request:FastifyRequest, reply:FastifyReply) => { reply.header('Cache-Control','no-store'); }};
const loginErrorStatus = (code:string): number => code==='TIMEOUT_UNKNOWN' ? 504 : code==='BAD_MESSAGE' ? 400 : code==='INTERNAL' ? 500 : 409;

type Operations = Pick<PersistentLoginOperations, 'execute' | 'current' | 'readIdleStep' | 'release' | 'recovery'>;
export interface ChannelControlOptions {
  loginStep(platform: AdapterPlatform): AdapterLoginStep | null;
  assertAdmission?: () => void;
}

export function registerChannelControlRoutes(app:FastifyInstance, operations:Operations, authenticate:(token:string)=>Promise<string|null>, options:ChannelControlOptions):void {
  const actorFor = async (authorization: string | undefined): Promise<string | null> => {
    const match = /^Bearer (.+)$/.exec(authorization ?? '');
    return match ? authenticate(match[1]!) : null;
  };
  for (const [suffix,type] of [['login','account.login'],['login/submit','account.login.submit'],['logout','account.logout']] as const) {
    app.post<{Params:{platform:string}}>(prefix+'/'+suffix, noStore, async (req,reply) => {
      if (!await actorFor(req.headers.authorization)) return reply.code(401).send(error('UNAUTHORIZED'));
      const parsedPlatform = platform.safeParse(req.params.platform);
      const payload = type==='account.login.submit' ? submit.safeParse(req.body) : empty.safeParse(req.body ?? {});
      if (!parsedPlatform.success || !payload.success) return reply.code(400).send(error('BAD_REQUEST'));
      try {
        const result = await operations.execute(parsedPlatform.data,type,payload.data,options.assertAdmission);
        let code: string;
        switch (result.kind) {
          case 'ack':
            if (result.ack.ok) return { data: {} };
            code = result.ack.error ?? 'INTERNAL';
            if (!['TIMEOUT_UNKNOWN','CAPABILITY_UNSUPPORTED','CHANNEL_UNAVAILABLE','BAD_MESSAGE','INTERNAL'].includes(code)) code = 'INTERNAL';
            break;
          case 'rejected': code = result.code; break;
          case 'unavailable': code = 'CHANNEL_UNAVAILABLE'; break;
          case 'invalid': code = 'INTERNAL'; break;
          case 'blocked': case 'unknown': code = 'TIMEOUT_UNKNOWN'; break;
        }
        return reply.code(loginErrorStatus(code)).send(error(code));
      } catch {
        return reply.code(504).send(error('TIMEOUT_UNKNOWN'));
      }
    });
  }

  app.get<{Params:{platform:string}}>(prefix+'/login/step', noStore, async (req,reply) => {
    try {
      const authorization = req.headers.authorization;
      const actor = await actorFor(authorization);
      if (!actor) return reply.code(401).send(error('UNAUTHORIZED'));
      const parsed = platform.safeParse(req.params.platform);
      if (!parsed.success || !empty.safeParse(req.query).success) return reply.code(400).send(error('BAD_REQUEST'));
      options.assertAdmission?.();
      const candidateId = options.loginStep(parsed.data)?.challengeId;
      return { data: await operations.readIdleStep(parsed.data, () => {
        options.assertAdmission?.();
        // Idle evidence for an earlier challenge cannot authorize returning a replacement.
        if (candidateId === undefined) return null;
        const current = options.loginStep(parsed.data);
        return current?.challengeId === candidateId ? current : null;
      }, candidateId === undefined ? undefined : async () => {
        if (await actorFor(authorization) !== actor) throw STEP_AUTH_CHANGED;
      }) };
    } catch (cause) {
      if (cause === STEP_AUTH_CHANGED) return reply.code(401).send(error('UNAUTHORIZED'));
      return reply.code(503).send(error('INTERNAL'));
    }
  });

  app.get<{Params:{platform:string}}>(prefix+'/login/operation', noStore, async (req,reply) => {
    if (!await actorFor(req.headers.authorization)) return reply.code(401).send(error('UNAUTHORIZED'));
    const parsed = platform.safeParse(req.params.platform);
    if (!parsed.success || !empty.safeParse(req.query).success) return reply.code(400).send(error('BAD_REQUEST'));
    try { return { data: await operations.current(parsed.data) }; }
    catch { return reply.code(503).send(error('INTERNAL')); }
  });

  app.post<{Params:{platform:string}}>(prefix+'/login/operation/release', noStore, async (req,reply) => {
    const actor = await actorFor(req.headers.authorization);
    if (!actor) return reply.code(401).send(error('UNAUTHORIZED'));
    const parsed = platform.safeParse(req.params.platform);
    const input = release.safeParse(req.body);
    if (!parsed.success || !input.success || !empty.safeParse(req.query).success) return reply.code(400).send(error('BAD_REQUEST'));
    try { options.assertAdmission?.(); }
    catch { return reply.code(503).send(error('INTERNAL')); }
    try {
      if (!await operations.release(parsed.data,input.data.operationId,input.data.outcome,actor)) return reply.code(409).send(error('CONFLICT'));
      return { data: {} };
    } catch { return reply.code(504).send(error('TIMEOUT_UNKNOWN')); }
  });

  app.get<{Params:{platform:string;operationId:string}}>(prefix+'/login/operation/recovery/:operationId', noStore, async (req,reply) => {
    if (!await actorFor(req.headers.authorization)) return reply.code(401).send(error('UNAUTHORIZED'));
    const parsed = platform.safeParse(req.params.platform);
    const id = operationId.safeParse(req.params.operationId);
    if (!parsed.success || !id.success || !empty.safeParse(req.query).success) return reply.code(400).send(error('BAD_REQUEST'));
    try { return { data: await operations.recovery(parsed.data,id.data) }; }
    catch { return reply.code(503).send(error('INTERNAL')); }
  });
}
