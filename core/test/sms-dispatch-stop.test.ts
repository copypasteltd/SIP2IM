import { describe, expect, it, vi } from 'vitest';
import { SmsDispatcher, type SmsDispatchPorts } from '../src/sms/dispatch.js';
import { SimRateLimiter } from '../src/sms/state.js';

function deferred<T>() { let resolve!: (value:T)=>void; const promise = new Promise<T>(r => { resolve = r; }); return {promise, resolve}; }
const task = {id:'a', simId:'sim', deviceId:'dev', createdAt:0};
function fixture(overrides: Partial<SmsDispatchPorts> = {}) {
  const ports: SmsDispatchPorts = {queued:vi.fn(async()=>[task]), canCommand:vi.fn(async()=>true), simState:vi.fn(async()=> 'ready' as const), mark:vi.fn(async()=>true), send:vi.fn(async()=>({ok:true,error:null})), ...overrides};
  return {ports, dispatcher:new SmsDispatcher(ports,new SimRateLimiter(()=>0),()=>0)};
}

describe('SMS dispatcher stop', () => {
  it('closes admission while a queue lookup is pending', async () => {
    const queue=deferred<typeof task[]>(); const {ports,dispatcher}=fixture({queued:()=>queue.promise});
    const flushing=dispatcher.flush('dev',null); await Promise.resolve();
    const stopping=dispatcher.stop(); await dispatcher.flush('other',null);
    queue.resolve([task]); await Promise.all([flushing,stopping]);
    expect(ports.send).not.toHaveBeenCalled(); expect(ports.mark).not.toHaveBeenCalled();
  });
  it('waits for an in-flight dispatch mark and does not send after stop', async () => {
    const entered=deferred<void>(), mark=deferred<boolean>();
    const {ports,dispatcher}=fixture({mark:vi.fn(async (_id,from)=>{if(from==='queued'){entered.resolve();return mark.promise;} return true;})});
    const flushing=dispatcher.flush('dev',null); await entered.promise;
    let done=false; const stopping=dispatcher.stop().then(()=>{done=true}); await Promise.resolve(); expect(done).toBe(false);
    mark.resolve(true); await Promise.all([flushing,stopping]);
    expect(ports.send).not.toHaveBeenCalled(); expect(ports.mark).toHaveBeenCalledWith('a','dispatched','unknown',null);
  });
  it('waits for an in-flight send and its final mark, without sending the next task', async () => {
    const entered=deferred<void>(), send=deferred<{ok:boolean;error:null}>(), marking=deferred<boolean>(), final=deferred<void>();
    const {ports,dispatcher}=fixture({queued:async()=>[task,{...task,id:'b'}],send:vi.fn(()=>{entered.resolve();return send.promise;}),mark:vi.fn(async(_id,from)=>{if(from==='dispatched'){final.resolve();return marking.promise;}return true;})});
    const flushing=dispatcher.flush('dev',null); await entered.promise;
    let done=false; const stopping=dispatcher.stop().then(()=>{done=true}); send.resolve({ok:true,error:null}); await final.promise; expect(done).toBe(false);
    marking.resolve(true); await Promise.all([flushing,stopping]); expect(ports.send).toHaveBeenCalledTimes(1);
  });
  it('waits for a timer rate lookup and never sends after stop', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    try {
      const rate = deferred<number | null>(), entered = deferred<void>();
      const ports: SmsDispatchPorts = {
        queued: vi.fn(async () => [task]), canCommand: vi.fn(async () => true),
        simState: vi.fn(async () => 'ready' as const), mark: vi.fn(async () => true),
        send: vi.fn(async () => ({ok:true,error:null})),
        currentRate: vi.fn(() => { entered.resolve(); return rate.promise; }),
      };
      const dispatcher = new SmsDispatcher(ports, new SimRateLimiter(() => Date.now()), () => Date.now());
      // Consume the only token, leaving a wakeup for the still-queued task.
      await dispatcher.flush('dev', 1);
      await dispatcher.flush('dev', 1);
      await vi.advanceTimersByTimeAsync(60000);
      await entered.promise;
      let done = false;
      const stopping = dispatcher.stop().then(() => { done = true; });
      await Promise.resolve(); await Promise.resolve();
      expect(done).toBe(false);
      rate.resolve(null);
      await stopping;
      expect(ports.send).toHaveBeenCalledTimes(1);
      expect(ports.queued).toHaveBeenCalledTimes(2);
    } finally { vi.useRealTimers(); }
  });
  it('cancels a pending rate-limit wakeup on stop', async () => {
    vi.useFakeTimers();
    try {
      const currentRate = vi.fn(async () => null);
      const {ports, dispatcher} = fixture({currentRate});
      await dispatcher.flush('dev', 1);
      await dispatcher.flush('dev', 1);
      await dispatcher.stop();
      await vi.advanceTimersByTimeAsync(60000);
      expect(currentRate).not.toHaveBeenCalled();
      expect(ports.send).toHaveBeenCalledTimes(1);
    } finally { vi.useRealTimers(); }
  });
  it('drains the underlying send even after its acknowledgement timeout', async () => {
    vi.useFakeTimers();
    try {
      const entered=deferred<void>(), send=deferred<{ok:boolean;error:null}>();
      const {dispatcher}=fixture({send:()=>{entered.resolve();return send.promise;}});
      const flushing=dispatcher.flush('dev',null); await entered.promise;
      await vi.advanceTimersByTimeAsync(10000); await flushing;
      let done=false; const stopping=dispatcher.stop().then(()=>{done=true}); await Promise.resolve(); await Promise.resolve(); expect(done).toBe(false);
      send.resolve({ok:true,error:null}); await stopping; expect(done).toBe(true);
    } finally {vi.useRealTimers();}
  });
});
