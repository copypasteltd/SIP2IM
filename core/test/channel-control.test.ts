import { it, expect, vi } from 'vitest';
import Fastify from 'fastify';
import { registerChannelControlRoutes } from '../src/channels/control-routes.js';
import type { ChannelControlOptions } from '../src/channels/control-routes.js';
import type { PersistentLoginOperations } from '../src/channels/login-persistent.js';

type Operations = Pick<PersistentLoginOperations,'execute'|'current'|'release'|'recovery'>;
const headers={authorization:'Bearer fake-admin-session'};
const id='00000000-0000-4000-8000-000000000001';
function setup() {
 const operations = {execute:vi.fn<Operations['execute']>(),current:vi.fn<Operations['current']>(),release:vi.fn<Operations['release']>(),recovery:vi.fn<Operations['recovery']>()};
 const loginStep=vi.fn<ChannelControlOptions['loginStep']>(); const assertAdmission=vi.fn();
 const app=Fastify();
 registerChannelControlRoutes(app,operations,async token=>token==='fake-admin-session'?'adm_real_from_token':null,{loginStep,assertAdmission});
 return {app,operations,loginStep,assertAdmission};
}

it('preserves the existing authenticated login request and ACK/error contract',async()=>{
 const {app,operations,assertAdmission}=setup();
 operations.execute.mockResolvedValue({kind:'ack',ack:{refId:'x',ok:true,error:null}});
 try {
  const unauthorized=await app.inject({method:'POST',url:'/api/channels/qq/login'});
  expect(unauthorized.statusCode).toBe(401);expect(unauthorized.headers['cache-control']).toBe('no-store');
  for(const [url,payload] of [['/api/channels/other/login',{}],['/api/channels/qq/login',{extra:true}],['/api/channels/telegram/login/submit',{step:'bad',value:'x'}],['/api/channels/telegram/login/submit',{step:'code',value:''}],['/api/channels/telegram/login/submit',{step:'code',value:'x',extra:true}]] as const) expect((await app.inject({method:'POST',url,headers,payload})).statusCode).toBe(400);
  expect(operations.execute).not.toHaveBeenCalled();
  expect((await app.inject({method:'POST',url:'/api/channels/qq/login',headers})).json()).toEqual({data:{}});
  expect((await app.inject({method:'POST',url:'/api/channels/telegram/login/submit',headers,payload:{step:'password',value:'fictional'}})).json()).toEqual({data:{}});
  expect((await app.inject({method:'POST',url:'/api/channels/qq/logout',headers})).json()).toEqual({data:{}});
  expect(operations.execute.mock.calls).toEqual([['qq','account.login',{},assertAdmission],['telegram','account.login.submit',{step:'password',value:'fictional'},assertAdmission],['qq','account.logout',{},assertAdmission]]);
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
 const {app,operations,loginStep}=setup();
 try {
  for(const url of ['/api/channels/qq/login/step','/api/channels/qq/login/operation','/api/channels/qq/login/operation/recovery/'+id]){
   const res=await app.inject({url});expect(res.statusCode).toBe(401);expect(res.headers['cache-control']).toBe('no-store');
  }
  expect((await app.inject({url:'/api/channels/other/login/operation',headers})).statusCode).toBe(400);
  expect((await app.inject({url:'/api/channels/qq/login/step?extra=1',headers})).statusCode).toBe(400);
  expect((await app.inject({url:'/api/channels/qq/login/operation/recovery/bad-id',headers})).statusCode).toBe(400);
  expect(loginStep).not.toHaveBeenCalled();expect(operations.current).not.toHaveBeenCalled();expect(operations.recovery).not.toHaveBeenCalled();
  loginStep.mockReturnValueOnce({step:'code',qrPngBase64:null,hint:null}).mockReturnValueOnce(null);
  const step=await app.inject({url:'/api/channels/telegram/login/step',headers});
  expect(step.json()).toEqual({data:{step:'code',qrPngBase64:null,hint:null}});expect(step.headers['cache-control']).toBe('no-store');
  expect((await app.inject({url:'/api/channels/telegram/login/step',headers})).json()).toEqual({data:null});
  operations.current.mockResolvedValueOnce({status:'unknown',operationId:id,outcome:null}).mockRejectedValueOnce(new Error('internal-only'));
  expect((await app.inject({url:'/api/channels/qq/login/operation',headers})).json()).toEqual({data:{status:'unknown',operationId:id,outcome:null}});
  const failed=await app.inject({url:'/api/channels/qq/login/operation',headers});
  expect(failed.statusCode).toBe(503);expect(failed.body).not.toContain('internal-only');expect(failed.headers['cache-control']).toBe('no-store');
 } finally {await app.close();}
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
