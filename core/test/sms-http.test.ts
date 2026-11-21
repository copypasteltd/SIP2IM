import {it,expect,vi} from 'vitest';import {createServer,type HttpDeps} from '../src/http/server.js';
it('rejects embedded NUL before creating SMS and accepts Unicode',async()=>{
 const createSms=vi.fn(async()=>({message:{id:'sms'},conflict:false}));
 const deps:HttpDeps={login:async()=>null,authenticate:async()=> 'admin',admin:async()=>null,logout:async()=>{},changePassword:async()=>false,setLocale:async()=>{},createCode:async()=>({code:'000000',expiresAt:0}),bind:async()=>({error:'BINDING_INVALID'}),health:async()=>true,getSettings:async()=>({}),listChannels:async()=>[],listCalls:async()=>({data:[],nextCursor:null}),listSms:async()=>({data:[],nextCursor:null}),listThreads:async()=>({data:[],nextCursor:null}),createSms,updateDevice:async()=>null,reviewSim:async()=>null,setSimNumber:async()=>null,probeDevice:async()=> 'ok',deviceDetail:async()=>null,listDevices:async()=>({data:[],nextCursor:null}),revokeDevice:async()=>true,publicHost:'x',port:1};
 const app=createServer(deps);
 try {
  const headers={authorization:'Bearer valid','idempotency-key':'x'};
  const payload={simId:'sim_01ARZ3NDEKTSV4RRFFQ69G5FAV',to:'12345',body:'before\0after'};
  const invalid=await app.inject({method:'POST',url:'/api/sms',headers,payload});
  expect(invalid.statusCode).toBe(400);
  expect(invalid.json().error.code).toBe('BAD_REQUEST');
  expect(createSms).not.toHaveBeenCalled();
  const body='你好 🌍 café';
  const valid=await app.inject({method:'POST',url:'/api/sms',headers,payload:{...payload,body}});
  expect(valid.statusCode).toBe(200);
  expect(createSms).toHaveBeenCalledOnce();
  expect(createSms).toHaveBeenCalledWith('x',payload.simId,'12345',body);
 } finally {await app.close();}
});
it('requires idempotency and rejects conflicting keys',async()=>{const deps:HttpDeps={login:async()=>null,authenticate:async()=> 'admin',admin:async()=>null,logout:async()=>{},changePassword:async()=>false,setLocale:async()=>{},createCode:async()=>({code:'000000',expiresAt:0}),bind:async()=>({error:'BINDING_INVALID'}),health:async()=>true,getSettings:async()=>({}),listChannels:async()=>[],listCalls:async()=>({data:[],nextCursor:null}),listSms:async()=>({data:[],nextCursor:null}),listThreads:async()=>({data:[],nextCursor:null}),createSms:async()=>({message:{id:'sms'},conflict:true}),updateDevice:async()=>null,reviewSim:async()=>null,setSimNumber:async()=>null,probeDevice:async()=> 'ok',deviceDetail:async()=>null,listDevices:async()=>({data:[],nextCursor:null}),revokeDevice:async()=>true,publicHost:'x',port:1};const app=createServer(deps);try{const payload={simId:'sim_01ARZ3NDEKTSV4RRFFQ69G5FAV',to:'12345',body:'test'};expect((await app.inject({method:'POST',url:'/api/sms',headers:{authorization:'Bearer valid'},payload})).json().error.code).toBe('IDEMPOTENCY_KEY_REQUIRED');expect((await app.inject({method:'POST',url:'/api/sms',headers:{authorization:'Bearer valid','idempotency-key':'x'},payload})).statusCode).toBe(409);}finally{await app.close();}});
