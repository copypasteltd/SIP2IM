import type {FastifyInstance} from 'fastify';
import type pg from 'pg';
import {ulid} from 'ulid';
export interface AuditRecord {action:string;targetType:string|null;targetId:string|null;ip:string}
const actions:Record<string,{action:string;targetType:string|null}>={
 'POST /api/devices/binding-codes':{action:'device.binding_code.create',targetType:null},
 'POST /api/devices/binding-codes/v2':{action:'device.binding_code.create',targetType:null},
 'POST /api/devices/binding-codes/:id/cancel':{action:'device.binding_code.cancel',targetType:'binding_code'},
 'PATCH /api/devices/:id':{action:'device.update',targetType:'device'},
 'PATCH /api/devices/:id/name':{action:'device.update',targetType:'device'},
 'DELETE /api/devices/:id':{action:'device.revoke',targetType:'device'},
 'POST /api/devices/:id/probe':{action:'device.probe',targetType:'device'},
 'PUT /api/sims/:id/number':{action:'sim.number.update',targetType:'sim'},
 'PUT /api/sims/:id/number/conditional':{action:'sim.number.update',targetType:'sim'},
 'POST /api/sims/:id/review':{action:'sim.review',targetType:'sim'},
 'POST /api/sms':{action:'sms.create',targetType:null},
 'PUT /api/settings':{action:'settings.update',targetType:null},
 'PUT /api/settings/conditional':{action:'settings.update',targetType:null},
 'PUT /api/channels/inbound':{action:'channel.inbound.update',targetType:null},
 'POST /api/channels/:platform/login':{action:'channel.login',targetType:'channel'},
 'POST /api/channels/:platform/login/submit':{action:'channel.login.submit',targetType:'channel'},
 'POST /api/channels/:platform/logout':{action:'channel.logout',targetType:'channel'},
 'DELETE /api/channels/:platform/paired-user':{action:'channel.paired_user.revoke',targetType:'channel'},
 'PUT /api/auth/password':{action:'admin.password.update',targetType:'admin'},
 'PUT /api/auth/locale':{action:'admin.locale.update',targetType:'admin'},
 'POST /api/alerts/:id/ack':{action:'alert.ack',targetType:'alert'}
};
export class AuditRepository {constructor(private readonly pool:pg.Pool){}async record(record:AuditRecord):Promise<void>{await this.pool.query('INSERT INTO audit_log(id,action,target_type,target_id,detail,ip) VALUES ($1,$2,$3,$4,$5,$6)',['aud_'+ulid(),record.action,record.targetType,record.targetId,'{}',record.ip]);}}
/** Records successful writes after the response; does not imply transactional audit durability. */
export function registerAudit(app:FastifyInstance,record:(item:AuditRecord)=>Promise<void>,onError:(error:unknown)=>void):void {app.addHook('onResponse',async(req,reply)=>{if(reply.statusCode<200||reply.statusCode>=300)return;const entry=actions[req.method+' '+req.routeOptions.url];if(!entry)return;const params=req.params as {id?:unknown;platform?:unknown}|undefined;try{await record({action:entry.action,targetType:entry.targetType,targetId:typeof params?.id==='string'?params.id:typeof params?.platform==='string'?params.platform:null,ip:req.ip});}catch(error){onError(error);}});}
