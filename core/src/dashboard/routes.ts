import type {FastifyInstance} from 'fastify';
import type {DashboardService} from './service.js';

export function registerDashboardRoute(app:FastifyInstance,service:DashboardService,authenticate:(token:string)=>Promise<string|null>):void {
  app.get('/api/dashboard',async(request,reply)=>{
    const match=/^Bearer (.+)$/.exec(request.headers.authorization??'');
    if(!match||!await authenticate(match[1]!))return reply.code(401).send({error:{code:'UNAUTHORIZED',message:'UNAUTHORIZED',details:null}});
    return {data:await service.get()};
  });
}
