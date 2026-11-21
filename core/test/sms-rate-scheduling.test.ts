import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {SmsDispatcher, type QueuedSms, type SmsDispatchPorts} from '../src/sms/dispatch.js';
import {SimRateLimiter} from '../src/sms/state.js';

function fixture() {
  const tasks: QueuedSms[] = [];
  const states = new Map<string,string>();
  const sent: string[] = [];
  const limiter = new SimRateLimiter(Date.now);
  const ports: SmsDispatchPorts = {
    queued: vi.fn(async () => tasks.filter(t => states.get(t.id) === 'queued')),
    canCommand: async () => true,
    simState: async () => 'ready',
    mark: async (id, from, to) => { if (states.get(id) !== from) return false; states.set(id, to); return true; },
    send: vi.fn(async t => { sent.push(t.id); return {ok:true,error:null}; }),
    currentRate: vi.fn(async () => 1),
  };
  const dispatcher = new SmsDispatcher(ports, limiter, Date.now);
  function add(id: string, simId: string) { tasks.push({id, simId, deviceId:'d', createdAt:tasks.length}); states.set(id,'queued'); }
  return {dispatcher, limiter, ports, sent, states, add};
}

describe('per-SIM refill scheduling', () => {
  beforeEach(() => {vi.useFakeTimers(); vi.setSystemTime(0);});
  afterEach(() => vi.useRealTimers());
  it('uses the earliest of distinct SIM deadlines and maintains FIFO across sustained backlog', async () => {
    const f=fixture();
    try {
      f.limiter.take('B',1); await vi.advanceTimersByTimeAsync(20000); f.limiter.take('A',1);
      for (const [id,sim] of [['A1','A'],['A2','A'],['B1','B'],['B2','B']]) f.add(id!,sim!);
      await f.dispatcher.flush('d',1); expect(f.sent).toEqual([]); expect(vi.getTimerCount()).toBe(1);
      await vi.advanceTimersByTimeAsync(40001); expect(f.sent).toEqual(['B1']); expect(vi.getTimerCount()).toBe(1);
      await vi.advanceTimersByTimeAsync(20000); expect(f.sent).toEqual(['B1','A1']);
      await vi.advanceTimersByTimeAsync(40001); expect(f.sent).toEqual(['B1','A1','B2']);
      await vi.advanceTimersByTimeAsync(20000); expect(f.sent).toEqual(['B1','A1','B2','A2']);
    } finally {await f.dispatcher.stop();}
  });
  it('replaces and cancels old timers when the queue or rate changes', async () => {
    const f=fixture();
    try {
      f.limiter.take('A',1); f.add('A1','A'); await f.dispatcher.flush('d',1);
      await vi.advanceTimersByTimeAsync(10000); f.limiter.take('B',1); f.add('B1','B');
      f.states.set('A1','failed'); await f.dispatcher.flush('d',1);
      await vi.advanceTimersByTimeAsync(50000); expect(f.sent).toEqual([]);
      await vi.advanceTimersByTimeAsync(10000); expect(f.sent).toEqual(['B1']);
      f.add('B2','B'); await f.dispatcher.flush('d',1); await f.dispatcher.flush('d',null);
      expect(f.sent).toEqual(['B1','B2']); expect(vi.getTimerCount()).toBe(0);
    } finally {await f.dispatcher.stop();}
  });
  it('reads the current rate on wake and retries transient lookup errors', async () => {
    const f=fixture(); let calls=0;
    f.ports.currentRate=vi.fn(async()=>{if (++calls===1) throw Error('transient'); return null;});
    try {
      f.limiter.take('A',1); f.add('A1','A'); await f.dispatcher.flush('d',1);
      await vi.advanceTimersByTimeAsync(60000); expect(f.sent).toEqual([]); expect(vi.getTimerCount()).toBe(1);
      await vi.advanceTimersByTimeAsync(1000); expect(f.sent).toEqual(['A1']); expect(calls).toBe(2);
    } finally {await f.dispatcher.stop();}
  });
  it('ignores a stale pending rate lookup after a newer flush', async () => {
    const f=fixture(); let resolve!: (value:number|null)=>void; let entered!:()=>void;
    const started=new Promise<void>(r=>{entered=r});
    f.ports.currentRate=()=>{entered(); return new Promise(r=>{resolve=r});};
    try {
      f.limiter.take('A',1); f.add('A1','A'); await f.dispatcher.flush('d',1);
      await vi.advanceTimersByTimeAsync(60000); await started;
      await f.dispatcher.flush('d',null); expect(f.sent).toEqual(['A1']);
      resolve(1); await Promise.resolve(); await Promise.resolve();
      expect(f.sent).toEqual(['A1']); expect(vi.getTimerCount()).toBe(0);
    } finally {await f.dispatcher.stop();}
  });
  it('preserves a pending wakeup if an external flush fails mid-pass', async () => {
    const f=fixture(); f.limiter.take('A',1); f.add('A1','A'); await f.dispatcher.flush('d',1);
    f.ports.simState=vi.fn().mockRejectedValueOnce(Error('temporary')).mockResolvedValue('ready');
    try {
      await expect(f.dispatcher.flush('d',1)).rejects.toThrow('temporary');
      expect(vi.getTimerCount()).toBe(1); await vi.advanceTimersByTimeAsync(60001);
      expect(f.sent).toEqual(['A1']);
    } finally {await f.dispatcher.stop();}
  });
  it('retries promptly after a failed pass at an unlimited updated rate', async () => {
    const f=fixture(); f.limiter.take('A',1); f.add('A1','A'); await f.dispatcher.flush('d',1);
    f.ports.simState=vi.fn().mockRejectedValueOnce(Error('temporary')).mockResolvedValue('ready');
    f.ports.currentRate=vi.fn(async()=>null);
    try {
      await expect(f.dispatcher.flush('d',null)).rejects.toThrow('temporary');
      await vi.advanceTimersByTimeAsync(999); expect(f.sent).toEqual([]);
      await vi.advanceTimersByTimeAsync(1); expect(f.sent).toEqual(['A1']);
    } finally {await f.dispatcher.stop();}
  });
  it('uses a concurrent unlimited rate after failure without a rate lookup port', async () => {
    const f=fixture(); delete f.ports.currentRate;
    f.limiter.take('A',1); f.add('A1','A'); await f.dispatcher.flush('d',1);
    let reject!: (error: Error)=>void; let entered!:()=>void;
    const started=new Promise<void>(r=>{entered=r});
    f.ports.simState=vi.fn().mockImplementationOnce(()=>{entered(); return new Promise((_resolve,r)=>{reject=r;});}).mockResolvedValue('ready');
    const pending=f.dispatcher.flush('d',1); const failure=expect(pending).rejects.toThrow('temporary');
    try {
      await started; await f.dispatcher.flush('d',null); reject(Error('temporary')); await failure;
      await vi.advanceTimersByTimeAsync(1000); expect(f.sent).toEqual(['A1']); expect(vi.getTimerCount()).toBe(0);
    } finally {await f.dispatcher.stop();}
  });
  it('retries when a timer fires during a failing active pass', async () => {
    const f=fixture(); f.limiter.take('A',1); f.add('A1','A'); await f.dispatcher.flush('d',1);
    let release!:()=>void; let entered!:()=>void;
    const gate=new Promise<void>(r=>{release=r}); const started=new Promise<void>(r=>{entered=r});
    f.ports.queued=vi.fn(async()=>{entered(); await gate; throw Error('queue error');});
    const pending=f.dispatcher.flush('d',1); const rejection=expect(pending).rejects.toThrow('queue error');
    try {
      await started; await vi.advanceTimersByTimeAsync(60000); release(); await rejection;
      expect(vi.getTimerCount()).toBe(1);
      f.ports.queued=async()=>[{id:'A1',simId:'A',deviceId:'d',createdAt:0}];
      await vi.advanceTimersByTimeAsync(1000); expect(f.sent).toEqual(['A1']);
    } finally {release(); await f.dispatcher.stop();}
  });
  it('cancels the earliest outstanding wakeup on stop', async () => {
    const f=fixture(); f.limiter.take('A',1); f.add('A1','A'); await f.dispatcher.flush('d',1);
    await f.dispatcher.stop(); await vi.advanceTimersByTimeAsync(120000);
    expect(f.sent).toEqual([]); expect(f.ports.currentRate).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  });
});
