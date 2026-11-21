import {afterEach,expect,it,vi} from 'vitest';
import {SmsRateRuntime} from '../src/sms/rate-runtime.js';
const deferred=<T>()=>{let resolve!:(value:T)=>void;const promise=new Promise<T>(r=>resolve=r);return {promise,resolve};};
afterEach(()=>vi.useRealTimers());

it('applies the latest confirmed rate immediately and coalesces old inventory work',async()=>{
  const old=deferred<string[]>(), entered=deferred<void>();
  const flush=vi.fn(async()=>{}), setRate=vi.fn();
  const queuedDevices=vi.fn().mockImplementationOnce(()=>{entered.resolve();return old.promise;}).mockResolvedValue(['new']);
  const runtime=new SmsRateRuntime({readRate:async()=>1,queuedDevices,setRate,flush,report:()=>{}});
  runtime.changed(null);
  await entered.promise;
  runtime.changed(1);
  runtime.changed(2);
  expect(setRate.mock.calls).toEqual([[null],[1],[2]]);
  expect(queuedDevices).toHaveBeenCalledOnce();
  const refresh=runtime.refresh();
  expect(runtime.refresh()).toBe(refresh);
  old.resolve(['stale']);
  await refresh;
  expect(queuedDevices).toHaveBeenCalledTimes(2);
  expect(flush.mock.calls).toEqual([['new',2]]);
  await runtime.stop();
});

it('waits for a confirmed startup rate, retries one read and then finds queued devices without awaiting SMS ACK',async()=>{
  vi.useFakeTimers();
  const ack=deferred<void>();
  const readRate=vi.fn().mockRejectedValueOnce(Error('read failed')).mockResolvedValue(3);
  const queuedDevices=vi.fn(async()=>['direct','recovered']);
  const flush=vi.fn(()=>ack.promise), report=vi.fn();
  const runtime=new SmsRateRuntime({readRate,queuedDevices,setRate:vi.fn(),flush,report});
  runtime.request('direct'); runtime.request('direct');
  await vi.advanceTimersByTimeAsync(0);
  expect(flush).not.toHaveBeenCalled();
  expect(readRate).toHaveBeenCalledOnce();
  expect(report).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(1000);
  expect(readRate).toHaveBeenCalledTimes(2);
  expect(flush.mock.calls).toEqual([['direct',3],['recovered',3]]);
  await runtime.stop();
  ack.resolve();
  expect(vi.getTimerCount()).toBe(0);
});

it('pauses on uncertain writes even after later updates and discards stale reads',async()=>{
  const setRate=vi.fn(),flush=vi.fn(async()=>{}),read=deferred<number|null>(), entered=deferred<void>();
  const readRate=vi.fn(()=>{entered.resolve();return read.promise;});
  const runtime=new SmsRateRuntime({setRate,flush,readRate,queuedDevices:async()=>['d'],report:()=>{}});
  const refresh=runtime.refresh(); await entered.promise;
  runtime.changed(undefined); runtime.changed(null); runtime.request('d');
  read.resolve(null); await refresh; await runtime.refresh();
  expect(setRate.mock.calls).toEqual([[undefined]]);
  expect(flush).not.toHaveBeenCalled();
  expect(readRate).toHaveBeenCalledOnce();
  await runtime.stop();
});

it('suspends sending while reloading a known committed rate and fences a stale in-flight read',async()=>{
  const prior=deferred<number|null>(), next=deferred<number|null>(), priorEntered=deferred<void>(), nextEntered=deferred<void>();
  const readRate=vi.fn().mockImplementationOnce(()=>{priorEntered.resolve();return prior.promise;}).mockImplementationOnce(()=>{nextEntered.resolve();return next.promise;});
  const flush=vi.fn(async()=>{}), setRate=vi.fn();
  const runtime=new SmsRateRuntime({setRate,flush,readRate,queuedDevices:async()=>['recovered'],report:()=>{}});
  runtime.changed(null); await runtime.refresh(); flush.mockClear();
  const reloading=runtime.refresh(); await priorEntered.promise;
  runtime.invalidate(); runtime.request('queued');
  expect(setRate).toHaveBeenLastCalledWith(undefined);
  expect(flush).not.toHaveBeenCalled();
  prior.resolve(null); await nextEntered.promise;
  expect(setRate.mock.calls).toEqual([[null],[undefined]]);
  next.resolve(1); await reloading;
  expect(setRate).toHaveBeenLastCalledWith(1);
  expect(flush.mock.calls).toEqual([['queued',1],['recovered',1]]);
  runtime.changed(undefined); runtime.invalidate(); await runtime.refresh();
  expect(setRate).toHaveBeenLastCalledWith(undefined);
  expect(readRate).toHaveBeenCalledTimes(2);
  await runtime.stop();
});

it('drains the active inventory and schedules nothing after stop',async()=>{
  const flush=vi.fn(async()=>{}), inventory=deferred<string[]>(), entered=deferred<void>();
  const runtime=new SmsRateRuntime({setRate:vi.fn(),flush,readRate:async()=>null,queuedDevices:()=>{entered.resolve();return inventory.promise;},report:()=>{}});
  runtime.changed(null); await entered.promise;
  let done=false; const stopping=runtime.stop().then(()=>{done=true;});
  await Promise.resolve(); expect(done).toBe(false);
  inventory.resolve(['d']); await stopping;
  expect(flush).not.toHaveBeenCalled();
});
