import { expect, it, vi } from 'vitest';
import { SmsDispatcher, type SmsDispatchPorts } from '../src/sms/dispatch.js';
import { SimRateLimiter } from '../src/sms/state.js';

it('propagates negative ACK persistence failure without writing generic unknown', async () => {
  const task = {id:'a',simId:'sim',deviceId:'dev',createdAt:0};
  let persistedState = 'queued';
  const mark = vi.fn<SmsDispatchPorts['mark']>(async (_id,from,to)=> {
    if (from === 'dispatched' && to === 'failed') throw new Error('ACK write uncertain');
    if (persistedState !== from) return false;
    persistedState = to;
    return true;
  });
  const dispatcher = new SmsDispatcher({queued:async()=>[task],canCommand:async()=>true,simState:async()=> 'ready',mark,send:async()=>({ok:false,error:'rejected'})},new SimRateLimiter(()=>10),()=>10);
  await expect(dispatcher.flush('dev',null)).rejects.toThrow('ACK write uncertain');
  expect(mark).not.toHaveBeenCalledWith('a','dispatched','unknown',null);
  // This fake models a failed write: the negative ACK is not durable. A fenced
  // attempt and independent durable ACK evidence are needed for recovery.
  expect(persistedState).toBe('dispatched');
  await dispatcher.stop();
});
