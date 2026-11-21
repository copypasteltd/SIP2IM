import {afterEach,expect,it,vi} from 'vitest';
import type {QueuedDevicePage} from '../src/sms/queue-repo.js';
import {SmsRateRuntime} from '../src/sms/rate-runtime.js';
import {TrackedInterval} from '../src/tracked-interval.js';
const deferred=<T>()=>{let resolve!:(value:T)=>void;const promise=new Promise<T>(r=>resolve=r);return {promise,resolve};};
type Inventory = (after: string | null) => Promise<QueuedDevicePage>;
const page = (ids: string[] = [], nextAfter: string | null = null): QueuedDevicePage => ({ids,nextAfter});
const deviceIds = (start: number, count: number) => Array.from({length:count}, (_,i) => 'd'+String(start+i).padStart(3,'0'));
const fullPage = (start: number) => {
  const ids = deviceIds(start, 32);
  return page(ids, ids.at(-1)!);
};
afterEach(()=>vi.useRealTimers());

it('applies confirmed rates immediately and retries stale inventory from the last confirmed cursor',async()=>{
  const first=fullPage(1), old=deferred<QueuedDevicePage>(), entered=deferred<void>();
  const flush=vi.fn(async()=>{}), setRate=vi.fn();
  const queuedDevices=vi.fn<Inventory>().mockResolvedValueOnce(first)
    .mockImplementationOnce(()=>{entered.resolve();return old.promise;}).mockResolvedValue(page(['d033']));
  const runtime=new SmsRateRuntime({readRate:async()=>null,queuedDevices,setRate,flush,report:()=>{}});
  runtime.changed(null);
  await runtime.refresh();
  flush.mockClear();
  const refresh=runtime.refresh();
  await entered.promise;
  runtime.changed(1);
  runtime.changed(2);
  expect(setRate.mock.calls).toEqual([[null],[1],[2]]);
  expect(queuedDevices.mock.calls).toEqual([[null],[first.nextAfter]]);
  expect(runtime.refresh()).toBe(refresh);
  runtime.request('direct');
  expect(flush.mock.calls).toEqual([['direct',2]]);
  old.resolve(fullPage(33));
  await refresh;
  expect(queuedDevices.mock.calls).toEqual([[null],[first.nextAfter],[first.nextAfter]]);
  expect(flush.mock.calls).toEqual([['direct',2],['d033',2]]);
  await runtime.stop();
});

it('waits for a confirmed startup rate, retries one read and then finds queued devices without awaiting SMS ACK',async()=>{
  vi.useFakeTimers();
  const ack=deferred<void>();
  const readRate=vi.fn().mockRejectedValueOnce(Error('read failed')).mockResolvedValue(3);
  const queuedDevices=vi.fn(async()=>page(['direct','recovered']));
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
  const runtime=new SmsRateRuntime({setRate,flush,readRate,queuedDevices:async()=>page(['d']),report:()=>{}});
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
  const runtime=new SmsRateRuntime({setRate,flush,readRate,queuedDevices:async()=>page(['recovered']),report:()=>{}});
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
  const flush=vi.fn(async()=>{}), inventory=deferred<QueuedDevicePage>(), entered=deferred<void>();
  const queuedDevices=vi.fn<Inventory>(()=>{entered.resolve();return inventory.promise;});
  const runtime=new SmsRateRuntime({setRate:vi.fn(),flush,readRate:async()=>null,queuedDevices,report:()=>{}});
  runtime.changed(null); await entered.promise;
  let done=false; const stopping=runtime.stop().then(()=>{done=true;});
  await Promise.resolve(); expect(done).toBe(false);
  inventory.resolve(fullPage(1)); await stopping;
  runtime.request('direct'); runtime.changed(1); await runtime.refresh();
  expect(flush).not.toHaveBeenCalled();
  expect(queuedDevices).toHaveBeenCalledExactlyOnceWith(null);
});

it('recovers one page per periodic tick, continuing past a removed cursor and then wrapping',async()=>{
  vi.useFakeTimers();
  let eligible=deviceIds(1,35);
  const queuedDevices=vi.fn<Inventory>(async after=>{
    const ids=eligible.filter(id=>after===null||id>after).slice(0,33);
    return page(ids.slice(0,32),ids.length>32 ? ids[31]! : null);
  });
  const ack=deferred<void>(), flush=vi.fn((_id:string,_rate:number|null)=>ack.promise);
  const runtime=new SmsRateRuntime({setRate:vi.fn(),flush,readRate:async()=>2,queuedDevices,report:vi.fn()});
  const interval=new TrackedInterval(10_000,[()=>runtime.refresh()],vi.fn());
  const woken=()=>flush.mock.calls.map(([id])=>id);
  try {
    await runtime.refresh();
    expect(woken()).toEqual(deviceIds(1,32));
    eligible=['d000',...eligible.filter(id=>id!=='d032')];
    runtime.request('direct-only');
    expect(woken().at(-1)).toBe('direct-only');
    await vi.advanceTimersByTimeAsync(9_999);
    expect(queuedDevices.mock.calls).toEqual([[null]]);
    await vi.advanceTimersByTimeAsync(1);
    expect(queuedDevices.mock.calls).toEqual([[null],['d032']]);
    expect(woken().slice(32)).toEqual(['direct-only','d033','d034','d035']);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(queuedDevices.mock.calls).toEqual([[null],['d032'],[null]]);
    expect(woken().slice(36)).toEqual(deviceIds(0,32));
  } finally {
    await interval.stop(); await runtime.stop(); ack.resolve();
  }
  expect(vi.getTimerCount()).toBe(0);
});

it('wraps on the next refresh when the previously observed lookahead disappears',async()=>{
  const first=fullPage(1);
  const queuedDevices=vi.fn<Inventory>().mockResolvedValueOnce(first)
    .mockResolvedValueOnce(page()).mockResolvedValueOnce(page(['d001']));
  const flush=vi.fn(async()=>{});
  const runtime=new SmsRateRuntime({setRate:vi.fn(),flush,readRate:async()=>null,queuedDevices,report:vi.fn()});
  try {
    await runtime.refresh();
    flush.mockClear();
    await runtime.refresh();
    expect(queuedDevices.mock.calls).toEqual([[null],[first.nextAfter]]);
    expect(flush).not.toHaveBeenCalled();
    await runtime.refresh();
    expect(queuedDevices.mock.calls).toEqual([[null],[first.nextAfter],[null]]);
    expect(flush).toHaveBeenCalledExactlyOnceWith('d001',null);
  } finally { await runtime.stop(); }
});

it('backs off a failed page without skipping or resetting its cursor',async()=>{
  vi.useFakeTimers();
  const first=fullPage(1), failure=Error('inventory failed'), report=vi.fn(), flush=vi.fn(async()=>{});
  const queuedDevices=vi.fn<Inventory>().mockResolvedValueOnce(first)
    .mockRejectedValueOnce(failure).mockResolvedValueOnce(page(['d033']));
  const runtime=new SmsRateRuntime({setRate:vi.fn(),flush,readRate:async()=>null,queuedDevices,report});
  try {
    await runtime.refresh();
    flush.mockClear();
    await runtime.refresh();
    expect(report).toHaveBeenCalledExactlyOnceWith(failure);
    expect(flush).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(999);
    expect(queuedDevices.mock.calls).toEqual([[null],[first.nextAfter]]);
    await vi.advanceTimersByTimeAsync(1);
    expect(queuedDevices.mock.calls).toEqual([[null],[first.nextAfter],[first.nextAfter]]);
    expect(flush).toHaveBeenCalledExactlyOnceWith('d033',null);
  } finally { await runtime.stop(); }
});

it('discards inventory returned after a rate pause and keeps direct wakes until readback',async()=>{
  const first=fullPage(1), old=deferred<QueuedDevicePage>(), entered=deferred<void>();
  const newRate=deferred<number>(), rateEntered=deferred<void>();
  const queuedDevices=vi.fn<Inventory>().mockResolvedValueOnce(first)
    .mockImplementationOnce(()=>{entered.resolve();return old.promise;}).mockResolvedValueOnce(page(['d033']));
  const setRate=vi.fn(), flush=vi.fn(async()=>{});
  const readRate=vi.fn().mockResolvedValueOnce(2).mockResolvedValueOnce(2)
    .mockImplementationOnce(()=>{rateEntered.resolve();return newRate.promise;});
  const runtime=new SmsRateRuntime({setRate,flush,readRate,queuedDevices,report:vi.fn()});
  await runtime.refresh(); flush.mockClear();
  const refresh=runtime.refresh(); await entered.promise;
  runtime.invalidate(); runtime.request('direct');
  old.resolve(fullPage(33)); await rateEntered.promise;
  expect(setRate).toHaveBeenLastCalledWith(undefined);
  expect(flush).not.toHaveBeenCalled();
  newRate.resolve(3); await refresh;
  expect(queuedDevices.mock.calls).toEqual([[null],[first.nextAfter],[first.nextAfter]]);
  expect(flush.mock.calls).toEqual([['direct',3],['d033',3]]);
  await runtime.stop();
});

it('does not advance an inventory page interrupted during wake admission',async()=>{
  const first=fullPage(1), interrupted=fullPage(33);
  const queuedDevices=vi.fn<Inventory>().mockResolvedValueOnce(first).mockResolvedValue(interrupted);
  const flush=vi.fn(async(id:string, rate:number|null)=>{
    if (id==='d033' && rate===null) runtime.changed(2);
  });
  const runtime=new SmsRateRuntime({setRate:vi.fn(),flush,readRate:async()=>null,queuedDevices,report:vi.fn()});
  try {
    await runtime.refresh();
    flush.mockClear();
    await runtime.refresh();
    expect(queuedDevices.mock.calls).toEqual([[null],[first.nextAfter],[first.nextAfter]]);
    expect(flush.mock.calls).toEqual([['d033',null],...interrupted.ids.map(id=>[id,2])]);
  } finally { await runtime.stop(); }
});

it('bounds distinct direct hints during rate startup independently of durable discovery',async()=>{
  const rate=deferred<number>(), readRate=vi.fn(()=>rate.promise);
  const flush=vi.fn((_id:string,_rate:number|null)=>Promise.resolve());
  const queuedDevices=vi.fn<Inventory>().mockResolvedValue(page(['d258']));
  const runtime=new SmsRateRuntime({setRate:vi.fn(),flush,readRate,queuedDevices,report:vi.fn()});
  try {
    for (const id of deviceIds(1,258)) { runtime.request(id); runtime.request(id); }
    expect(flush).not.toHaveBeenCalled();
    rate.resolve(3); await runtime.refresh();
    expect(readRate).toHaveBeenCalledOnce();
    expect(queuedDevices).toHaveBeenCalledExactlyOnceWith(null);
    expect(flush.mock.calls.map(([id])=>id)).toEqual([...deviceIds(1,256),'d258']);
    runtime.request('d257');
    expect(flush).toHaveBeenLastCalledWith('d257',3);
  } finally { await runtime.stop(); }
});
