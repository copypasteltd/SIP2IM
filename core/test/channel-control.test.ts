import { it, expect, vi } from 'vitest';
import Fastify from 'fastify';
import { registerChannelControlRoutes } from '../src/channels/control-routes.js';
import type { ChannelControlOptions } from '../src/channels/control-routes.js';
import type { PersistentLoginOperations } from '../src/channels/login-persistent.js';
import { registerAudit } from '../src/http/audit.js';

type Operations = Pick<PersistentLoginOperations,'execute'|'current'|'readIdleStep'|'release'|'recovery'>;
const headers={authorization:'Bearer fake-admin-session'};
const id='00000000-0000-4000-8000-000000000001';
const challengeId='fedcba98-7654-4321-abc8-0123456789ab';
const submitUrl='/api/channels/telegram/login/submit';
function setup() {
 const operations = {
  execute:vi.fn<Operations['execute']>(),current:vi.fn<Operations['current']>(),
  readIdleStep:vi.fn<Operations['readIdleStep']>(async (_platform,select,reauthorize)=>{await reauthorize?.();return select();}),
  release:vi.fn<Operations['release']>(),recovery:vi.fn<Operations['recovery']>(),
 };
 const loginStep=vi.fn<ChannelControlOptions['loginStep']>().mockReturnValue(null); const assertAdmission=vi.fn();
 const app=Fastify(), audit=vi.fn(async()=>{});
 registerAudit(app,audit,vi.fn());
 const authenticate=vi.fn(async (token:string)=>token==='fake-admin-session'?'adm_real_from_token':null);
 registerChannelControlRoutes(app,operations,authenticate,{loginStep,assertAdmission});
 return {app,operations,loginStep,assertAdmission,audit,authenticate};
}

it('requires a canonical challenge ID on authenticated submissions and preserves the ACK/error contract',async()=>{
 const {app,operations,assertAdmission}=setup();
 operations.execute.mockResolvedValue({kind:'ack',ack:{refId:'x',ok:true,error:null}});
 try {
  const unauthorized=await app.inject({method:'POST',url:'/api/channels/qq/login'});
  expect(unauthorized.statusCode).toBe(401);expect(unauthorized.headers['cache-control']).toBe('no-store');
  const valid={step:'code',value:'fictional',challengeId};
  const noAuth=await app.inject({method:'POST',url:submitUrl,payload:valid});
  expect(noAuth.statusCode).toBe(401);expect(noAuth.headers['cache-control']).toBe('no-store');
  for(const [url,payload] of [['/api/channels/other/login',{}],['/api/channels/qq/login',{extra:true}]] as const) expect((await app.inject({method:'POST',url,headers,payload})).statusCode).toBe(400);
  const missing=await app.inject({method:'POST',url:submitUrl,headers});
  expect(missing.statusCode).toBe(400);expect(missing.json().error.code).toBe('BAD_REQUEST');
  for (const invalid of [null,[],{}, {step:'code',value:'fictional'}, {...valid,step:'invalid'}, {...valid,value:''},
      {...valid,value:'x'.repeat(4097)}, {...valid,extra:true}, {...valid,challengeId:null}, {...valid,challengeId:challengeId.toUpperCase()},
      {...valid,challengeId:challengeId.replace('-4321-','-7321-')}, {...valid,challengeId:challengeId.replace('-abc8-','-6bc8-')},
      {...valid,challengeId:challengeId+'\n'}]) {
   const response=await app.inject({method:'POST',url:submitUrl,headers:{...headers,'content-type':'application/json'},payload:JSON.stringify(invalid)});
   expect(response.statusCode).toBe(400);expect(response.json().error.code).toBe('BAD_REQUEST');
   expect(response.headers['cache-control']).toBe('no-store');
  }
  expect((await app.inject({method:'POST',url:submitUrl,headers:{...headers,'content-type':'application/json'},payload:'{'})).statusCode).toBe(400);
  expect(operations.execute).not.toHaveBeenCalled();
  expect((await app.inject({method:'POST',url:'/api/channels/qq/login',headers})).json()).toEqual({data:{}});
  const steps=['qr','phone','code','password'] as const;
  for(const step of steps) expect((await app.inject({method:'POST',url:submitUrl,headers,payload:{...valid,step}})).json()).toEqual({data:{}});
  expect((await app.inject({method:'POST',url:'/api/channels/qq/logout',headers})).json()).toEqual({data:{}});
  expect(operations.execute.mock.calls).toEqual([
   ['qq','account.login',{},assertAdmission], ...steps.map(step=>['telegram','account.login.submit',{...valid,step},assertAdmission]), ['qq','account.logout',{},assertAdmission],
  ]);
  for(const [code,status] of [['CAPABILITY_UNSUPPORTED',409],['TIMEOUT_UNKNOWN',504],['BAD_MESSAGE',400],['CHANNEL_UNAVAILABLE',409],['INTERNAL',500],['unexpected',500]] as const){
   operations.execute.mockResolvedValueOnce({kind:'ack',ack:{refId:'x',ok:false,error:code}});
   const res=await app.inject({method:'POST',url:'/api/channels/qq/login',headers});
   expect(res.statusCode).toBe(status);expect(res.json().error.code).toBe(code==='unexpected'?'INTERNAL':code);
   expect(res.headers['cache-control']).toBe('no-store');
  }
  operations.execute.mockResolvedValueOnce({kind:'rejected',code:'CHANNEL_UNAVAILABLE'});
  expect((await app.inject({method:'POST',url:'/api/channels/qq/login',headers})).statusCode).toBe(409);
  operations.execute.mockResolvedValueOnce({kind:'blocked'});
  expect((await app.inject({method:'POST',url:'/api/channels/qq/login',headers})).json().error.code).toBe('TIMEOUT_UNKNOWN');
 } finally {await app.close();}
});

it('reads the current challenge and operation only after authentication and validation',async()=>{
 const {app,operations,loginStep,audit}=setup();
 try {
  for(const url of ['/api/channels/qq/login/step','/api/channels/qq/login/operation','/api/channels/qq/login/operation/recovery/'+id]){
   const res=await app.inject({url});expect(res.statusCode).toBe(401);expect(res.headers['cache-control']).toBe('no-store');
  }
  expect((await app.inject({url:'/api/channels/qq/login/step',headers:{authorization:'Bearer rejected'}})).statusCode).toBe(401);
  for (const url of ['/api/channels/other/login/step','/api/channels/qq/login/step?extra=1',
      '/api/channels/other/login/operation','/api/channels/qq/login/operation/recovery/bad-id']) {
   const bad=await app.inject({url,headers});
   expect(bad.statusCode).toBe(400);expect(bad.json().error.code).toBe('BAD_REQUEST');
   expect(bad.headers['cache-control']).toBe('no-store');
  }
  expect(loginStep).not.toHaveBeenCalled();expect(operations.readIdleStep).not.toHaveBeenCalled();
  expect(operations.current).not.toHaveBeenCalled();expect(operations.recovery).not.toHaveBeenCalled();
  const prompt={step:'code' as const,qrPngBase64:null,hint:null,challengeId};
  loginStep.mockReturnValueOnce(prompt).mockReturnValueOnce({...prompt});
  const step=await app.inject({url:'/api/channels/telegram/login/step',headers});
  expect(step.json()).toEqual({data:prompt});expect(step.headers['cache-control']).toBe('no-store');
  expect((await app.inject({url:'/api/channels/telegram/login/step',headers})).json()).toEqual({data:null});
  loginStep.mockReturnValue(prompt);
  operations.readIdleStep.mockRejectedValueOnce(new Error('fixture private detail '+challengeId));
  const failedStep=await app.inject({url:'/api/channels/telegram/login/step',headers});
  expect(failedStep.statusCode).toBe(503);
  expect(failedStep.json()).toEqual({error:{code:'INTERNAL',message:'INTERNAL',details:null}});
  expect(failedStep.headers['cache-control']).toBe('no-store');
  expect(audit).not.toHaveBeenCalled();expect(operations.execute).not.toHaveBeenCalled();
  expect(operations.release).not.toHaveBeenCalled();expect(operations.recovery).not.toHaveBeenCalled();
  operations.current.mockResolvedValueOnce({status:'unknown',operationId:id,outcome:null}).mockRejectedValueOnce(new Error('internal-only'));
  expect((await app.inject({url:'/api/channels/qq/login/operation',headers})).json()).toEqual({data:{status:'unknown',operationId:id,outcome:null}});
  const failed=await app.inject({url:'/api/channels/qq/login/operation',headers});
  expect(failed.statusCode).toBe(503);expect(failed.body).not.toContain('internal-only');expect(failed.headers['cache-control']).toBe('no-store');
 } finally {await app.close();}
});

it('does not disclose a held login challenge after the administrator session has been revoked',async()=>{
 const {app,operations,loginStep,authenticate,audit}=setup();
 let enter!:()=>void, resume!:()=>void;
 const entered=new Promise<void>(resolve=>{enter=resolve;});
 const hold=new Promise<void>(resolve=>{resume=resolve;});
 const prompt={step:'qr' as const,qrPngBase64:'Zml4dHVyZQ==',hint:'offline challenge',challengeId};
 loginStep.mockReturnValue(prompt);
 operations.readIdleStep.mockImplementationOnce(async (_platform,select,reauthorize)=>{
  enter(); await hold; await reauthorize?.(); return select();
 });
 const reading=Promise.resolve(app.inject({url:'/api/channels/qq/login/step',headers}));
 try {
  await entered;
  authenticate.mockResolvedValue(null);
  resume(); const denied=await reading;
  expect(denied.statusCode).toBe(401);
  expect(denied.headers['cache-control']).toBe('no-store');
  expect(denied.json()).toEqual({error:{code:'UNAUTHORIZED',message:'UNAUTHORIZED',details:null}});
  expect(denied.body).not.toContain(challengeId);
  expect(denied.body).not.toContain(prompt.qrPngBase64);
  expect(loginStep).toHaveBeenCalledOnce();
  expect(authenticate).toHaveBeenCalledTimes(2);
  expect(operations.execute).not.toHaveBeenCalled(); expect(audit).not.toHaveBeenCalled();
 } finally {resume();await app.close();}
});

it('releases only exact terminal evidence under the authenticated actor and exposes exact audit review',async()=>{
 const {app,operations,assertAdmission}=setup();
 const url='/api/channels/qq/login/operation/release';
 const run=(payload:unknown) => app.inject({method:'POST',url,headers,payload:payload as object});
 try {
  const denied=await app.inject({url,method:'POST',payload:{operationId:id,outcome:'ack'}});
  expect(denied.statusCode).toBe(401);expect(denied.headers['cache-control']).toBe('no-store');
  const malformed=await app.inject({url,method:'POST',headers:{...headers,'content-type':'application/json'},payload:'{'});
  expect(malformed.statusCode).toBe(400);expect(malformed.headers['cache-control']).toBe('no-store');
  expect((await run({operationId:id,outcome:'unknown'})).statusCode).toBe(400);
  expect((await run({operationId:id,outcome:'ack',actor:'spoofed'})).statusCode).toBe(400);
  assertAdmission.mockImplementationOnce(()=>{throw Error('stopped');});
  expect((await run({operationId:id,outcome:'ack'})).statusCode).toBe(503);
  expect(operations.release).not.toHaveBeenCalled();
  operations.release.mockResolvedValueOnce(false).mockResolvedValueOnce(true).mockRejectedValueOnce(new Error('internal-only'));
  expect((await run({operationId:id,outcome:'ack'})).statusCode).toBe(409);
  expect((await run({operationId:id,outcome:'ack'})).json()).toEqual({data:{}});
  const uncertain=await run({operationId:id,outcome:'ack'});
  expect(uncertain.statusCode).toBe(504);expect(uncertain.body).not.toContain('internal-only');
  expect(operations.release).toHaveBeenLastCalledWith('qq',id,'ack','adm_real_from_token');
  const audit={operationId:id,platform:'qq' as const,outcome:'ack' as const,actor:'adm_real_from_token',terminalAt:'terminal',recoveredAt:'released'};
  operations.recovery.mockResolvedValueOnce(null).mockResolvedValueOnce(audit);
  expect((await app.inject({url:'/api/channels/telegram/login/operation/recovery/'+id,headers})).json()).toEqual({data:null});
  const result=await app.inject({url:'/api/channels/qq/login/operation/recovery/'+id,headers});
  expect(result.json()).toEqual({data:audit});expect(result.headers['cache-control']).toBe('no-store');
 } finally {await app.close();}
});
