import {it,expect,vi} from 'vitest';
import {SmsDispatcher} from '../src/sms/dispatch.js';
import {SimRateLimiter} from '../src/sms/state.js';

it('rechecks each SIM, retains unknown tasks, and fails unavailable tasks',async()=>{
 const states=new Map([['a','queued'],['b','queued'],['c','queued']]);
 const readiness=new Map([['a','unknown'],['b','unavailable'],['c','ready']]);
 const send=vi.fn(async()=>({ok:true,error:null}));
 const d=new SmsDispatcher({queued:async()=>[...states].filter(([,s])=>s==='queued').map(([id],createdAt)=>({id,simId:id,deviceId:'d',createdAt})),canCommand:async()=>true,simState:async id=>readiness.get(id) as 'ready'|'unknown'|'unavailable',mark:async(id,from,to)=>{if(states.get(id)!==from)return false;states.set(id,to);return true;},send},new SimRateLimiter(),()=>100);
 await d.flush('d',null);
 expect([...states.values()]).toEqual(['queued','failed','accepted']);expect(send.mock.calls).toHaveLength(1);
 readiness.set('a','ready');await d.flush('d',null);expect(states.get('a')).toBe('accepted');expect(send.mock.calls).toHaveLength(2);d.stop();
});
