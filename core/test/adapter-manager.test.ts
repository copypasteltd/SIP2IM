import { describe, expect, it, vi } from 'vitest';
import { IpcDecoder, decodeAdapterJson, encodeAdapterJson, encodeIpcFrame } from '@voipgw/protocol';
import { AdapterManager, AdapterAdmissionRejected } from '../src/channels/adapter-manager.js';
import { AdapterIpcListener } from '../src/adapters/ipc-listener.js';
import { EventEmitter } from 'node:events';

const id = (n: number) => 'ipc_' + String(n).padStart(26, '0');
const frame = (type: string, payload: unknown, n: number) => encodeIpcFrame({type:1,data:encodeAdapterJson({v:1,type,id:id(n),ts:1,payload})});
const read = (bytes: Uint8Array) => { const f = new IpcDecoder().push(bytes)[0]!; if (f.type !== 1) throw Error('not control'); return decodeAdapterJson(f.data); };
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
function socket() { return {write:vi.fn(),destroy:vi.fn()}; }
const hello = (platform: string, n = 1) => frame('adapter.hello',{platform,adapterVersion:'fake',protocol:1},n);

const capabilities = (login=true,n=2) => frame('capabilities',{login,sendMessage:false,receiveMessage:false,dial:false,receiveAudio:false,sendAudio:false,maxConcurrentCalls:0},n);
const account = (state='logged_out',n=3,selfId:string|null=null) => frame('account.state',{state,selfId,alias:null,detail:null},n);
const step = (kind='code',n=4) => frame('login.step',{step:kind,qrPngBase64:null,hint:null},n);
const startup = (connection:ReturnType<AdapterManager['attach']>,platform:string,state='logged_out',login=true) => {
  connection.data(hello(platform)); connection.data(capabilities(login)); connection.data(account(state));
};

async function clockedAdapter() {
  vi.useFakeTimers({toFake:['setTimeout','clearTimeout','Date']});
  let elapsed = 0;
  const manager = new AdapterManager({onEvent:async()=>{},onDisconnect:async()=>{}},10_000,()=>elapsed);
  const wire = socket(), link = manager.attach('telegram',wire);
  startup(link,'telegram');
  await new Promise<void>(done=>setImmediate(done));
  const clock = (at:number) => { elapsed = at; };
  const lastId = () => read(wire.write.mock.calls.at(-1)![0]).id;
  const ack = (refId:string, ok=true) => link.data(frame('ack',{refId,ok,error:ok?null:'INTERNAL'},90));
  return {manager,wire,link,clock,lastId,ack};
}

describe('adapter manager', () => {
  it('connects the listener raw transport to the manager without a real socket', async () => {
    class FakeSocket extends EventEmitter {
      destroyed=false; writableLength=0; writes:Uint8Array[]=[];
      write(bytes:Uint8Array) { this.writes.push(bytes); return true; }
      destroy() { if (!this.destroyed) { this.destroyed=true; this.emit('close'); } return this; }
      resume() { return this; }
    }
    const onEvent=vi.fn(async()=>{}), onDisconnect=vi.fn(async()=>{});
    const manager=new AdapterManager({onEvent,onDisconnect});
    const listener=new AdapterIpcListener({path:'/unused/fake.sock',onConnection:socket=>manager.attach('qq',socket)});
    const internal=listener as unknown as {ready:boolean;accept(socket:FakeSocket):void}; internal.ready=true;
    const peer=new FakeSocket(); internal.accept(peer);
    const bytes=hello('qq'); peer.emit('data',bytes.slice(0,3)); peer.emit('data',bytes.slice(3)); await tick();
    expect(onEvent).toHaveBeenCalledOnce(); expect(read(peer.writes[0]!).type).toBe('ack');
    peer.emit('data',capabilities()); peer.emit('data',account()); await tick();
    const command=manager.send('qq','account.login',{}); const outbound=read(peer.writes[3]!);
    peer.emit('data',frame('ack',{refId:outbound.id,ok:true,error:null},5)); expect((await command).ok).toBe(true);
    peer.destroy(); expect(onDisconnect).toHaveBeenCalledOnce();
  });
  it('handles fragmented startup and duplicate events without repeating effects', async () => {
    const onEvent = vi.fn(async () => {}), onDisconnect = vi.fn(async () => {});
    const manager = new AdapterManager({onEvent,onDisconnect}); const s=socket(), connection=manager.attach('qq',s);
    const first=hello('qq'); connection.data(first.slice(0,3)); connection.data(first.slice(3)); await tick();
    const caps=frame('capabilities',{login:true,sendMessage:false,receiveMessage:false,dial:false,receiveAudio:false,sendAudio:false,maxConcurrentCalls:0},2);
    connection.data(caps); connection.data(caps); await tick();
    expect(onEvent).toHaveBeenCalledTimes(2); expect(s.write).toHaveBeenCalledTimes(3);
    expect(read(s.write.mock.calls[2]![0]).payload).toEqual({refId:id(2),ok:true,error:null});
    manager.close(); expect(onDisconnect).toHaveBeenCalledTimes(1);
  });
  it('rejects wrong platform and non-hello first message', async () => {
    const manager = new AdapterManager({onEvent:async()=>{},onDisconnect:async()=>{}});
    const s=socket(); manager.attach('qq',s).data(hello('telegram')); await tick(); expect(s.destroy).toHaveBeenCalledOnce();
    const next=socket(); manager.attach('qq',next).data(frame('account.state',{state:'offline',selfId:null,alias:null,detail:null},3)); await tick(); expect(next.destroy).toHaveBeenCalledOnce();
  });
  it('correlates acknowledgements and rejects pending commands on replacement', async () => {
    const onDisconnect=vi.fn(async()=>{}); const manager=new AdapterManager({onEvent:async()=>{},onDisconnect});
    const s=socket(), conn=manager.attach('telegram',s); startup(conn,'telegram'); await tick();
    const sent=manager.send('telegram','account.login',{}); const command=read(s.write.mock.calls[3]![0]);
    conn.data(frame('ack',{refId:command.id,ok:true,error:null},4)); expect((await sent).ok).toBe(true);
    const pending=manager.send('telegram','account.logout',{}); const rejected=expect(pending).rejects.toThrow('outcome unknown');
    const replacement=socket(); manager.attach('telegram',replacement); await rejected;
    expect(s.destroy).toHaveBeenCalledOnce(); expect(onDisconnect).not.toHaveBeenCalled();
    conn.close(); expect(onDisconnect).not.toHaveBeenCalled(); manager.close(); expect(onDisconnect).toHaveBeenCalledOnce();
  });
  it('disconnects when queued events exceed the bounded limit', async () => {
    let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const manager = new AdapterManager({onEvent:async()=>blocked,onDisconnect:async()=>{}});
    const s=socket(), conn=manager.attach('qq',s); conn.data(hello('qq'));
    for (let n=2;n<=502;n++) conn.data(hello('qq',n));
    expect(s.destroy).toHaveBeenCalledOnce(); release(); await tick();
  });
  it('reports unknown on timeout without replay', async () => {
    const manager=new AdapterManager({onEvent:async()=>{},onDisconnect:async()=>{}},5);
    const s=socket(); startup(manager.attach('qq',s),'qq'); await tick();
    await expect(manager.send('qq','account.login',{})).rejects.toThrow('timeout; outcome unknown');
    await expect(manager.send('qq','message.send',{userId:'x',text:'test'})).rejects.toThrow('CAPABILITY_UNSUPPORTED');
    expect(s.write).toHaveBeenCalledTimes(4); manager.close();
  });

  it('admits login only after ordered startup and only when the backend supports it', async () => {
    const manager=new AdapterManager({onEvent:async()=>{},onDisconnect:async()=>{}});
    const s=socket(), connection=manager.attach('qq',s);
    connection.data(hello('qq')); await tick();
    expect(manager.status('qq')).toBe('unknown');
    expect(()=>manager.prepareLogin('qq','account.login',{})).toThrow('CHANNEL_UNAVAILABLE');
    connection.data(capabilities(false)); connection.data(account()); await tick();
    expect(manager.status('qq')).toBe('online');
    expect(()=>manager.prepareLogin('qq','account.login',{})).toThrow('CAPABILITY_UNSUPPORTED');
    expect(s.write).toHaveBeenCalledTimes(3);
    const other=socket(), stale=manager.attach('telegram',other);
    stale.data(hello('telegram')); stale.data(account()); await tick();
    expect(other.destroy).toHaveBeenCalledOnce();
    manager.close();
  });

  it('rechecks the challenge after an admission wait, including queued account changes', async () => {
    const manager=new AdapterManager({onEvent:async()=>{},onDisconnect:async()=>{}});
    const a=socket(), connection=manager.attach('telegram',a);
    startup(connection,'telegram','login_pending'); connection.data(step()); await tick();
    const current=manager.loginStep('telegram')!;
    expect(current).toEqual({step:'code',qrPngBase64:null,hint:null,challengeId:expect.any(String)});
    expect(()=>manager.prepareLogin('telegram','account.login.submit',{step:'phone',value:'fake',challengeId:current.challengeId})).toThrow('BAD_MESSAGE');
    const prepared=manager.prepareLogin('telegram','account.login.submit',{step:'code',value:'fake',challengeId:current.challengeId});
    connection.data(account('logged_in',5,'changed'));
    expect(()=>prepared()).toThrow(AdapterAdmissionRejected);
    await tick(); expect(manager.loginStep('telegram')).toBeNull();
    expect(()=>prepared()).toThrow('BAD_MESSAGE');
    expect(a.write).toHaveBeenCalledTimes(5);
    const again=manager.prepareLogin('telegram','account.logout',{});
    const b=socket(); startup(manager.attach('telegram',b),'telegram','login_pending'); await tick();
    expect(()=>again()).toThrow('CHANNEL_UNAVAILABLE');
    expect(manager.loginStep('telegram')).toBeNull(); expect(b.write).toHaveBeenCalledTimes(3);
    manager.close();
  });

  it('issues a fresh lowercase v4 ID per accepted step, not per duplicate ACK', async () => {
    const onLoginStep=vi.fn();
    const manager=new AdapterManager({onEvent:async()=>{},onDisconnect:async()=>{},onLoginStep});
    try {
      const s=socket(), first=manager.attach('qq',s);
      startup(first,'qq','login_pending');
      const original=step('code',4);
      first.data(original); await tick();
      const initial=manager.loginStep('qq')!;
      const uuidV4=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
      expect(initial.challengeId).toMatch(uuidV4);
      first.data(original); await tick();
      expect(manager.loginStep('qq')).toEqual(initial);
      expect(read(s.write.mock.calls[4]![0]).payload).toEqual({refId:id(4),ok:true,error:null});
      expect(onLoginStep).toHaveBeenCalledExactlyOnceWith('qq',initial,1,expect.any(Function));

      first.data(step('code',5)); await tick();
      const next=manager.loginStep('qq')!;
      expect(next).toEqual({...initial,challengeId:expect.stringMatching(uuidV4)});
      expect(next.challengeId).not.toBe(initial.challengeId);
      first.data(original); await tick();
      expect(manager.loginStep('qq')).toEqual(next);
      expect(onLoginStep).toHaveBeenCalledTimes(2);
      const prepared=manager.prepareLogin('qq','account.login.submit',{step:'code',value:'fake',challengeId:next.challengeId});

      const s2=socket(), second=manager.attach('qq',s2);
      expect(manager.loginStep('qq')).toBeNull();
      startup(second,'qq','login_pending'); second.data(original); await tick();
      const rotated=manager.loginStep('qq')!;
      expect(rotated.challengeId).toMatch(uuidV4);
      expect(new Set([initial.challengeId,next.challengeId,rotated.challengeId]).size).toBe(3);
      expect(()=>prepared()).toThrow('BAD_MESSAGE');
      expect(()=>manager.prepareLogin('qq','account.login.submit',{step:'code',value:'fake',challengeId:next.challengeId})).toThrow('BAD_MESSAGE');
      expect(s2.write).toHaveBeenCalledTimes(4);
      expect(onLoginStep).toHaveBeenLastCalledWith('qq',rotated,2,expect.any(Function));
    } finally { manager.close(); }
  });

  it('does not wait for a prompt subscriber and retires its evidence when the same connection reports completion', async () => {
    let release!: () => void;
    const wait = new Promise<void>(resolve => { release = resolve; });
    let entered!: () => void;
    const delivery = new Promise<void>(resolve => { entered = resolve; });
    let current: (() => boolean) | undefined;
    const onLoginStep = vi.fn(async (_platform, _step, _generation, guard: () => boolean) => {
      current = guard;
      entered();
      await wait;
    });
    const manager = new AdapterManager({ onEvent: async () => {}, onDisconnect: async () => {}, onLoginStep });
    try {
      const s = socket(), connection = manager.attach('telegram', s);
      startup(connection, 'telegram', 'login_pending');
      connection.data(step());
      await delivery;
      expect(manager.loginStep('telegram')).toMatchObject({ step: 'code' });
      expect(current?.()).toBe(true);
      expect(read(s.write.mock.calls[3]![0]).payload).toEqual({refId:id(4),ok:true,error:null});
      connection.data(account('logged_in',5,'fixture'));
      expect(current?.()).toBe(false);
      await tick();
      expect(read(s.write.mock.calls[4]![0]).payload).toEqual({refId:id(5),ok:true,error:null});
      expect(manager.loginStep('telegram')).toBeNull();
    } finally { release(); manager.close(); }
  });

  it.each([true,false])('settles an ACK just before the first cutoff without late evidence (ok=%s)',async ok=>{
    const f=await clockedAdapter(), evidence=vi.fn(async()=>{});
    try {
      const result=f.manager.prepareLogin('telegram','account.login',{})(evidence), refId=f.lastId();
      vi.setSystemTime(Date.now()+86_400_000);
      f.clock(9_999);
      f.ack(id(91),false);
      f.ack(refId,ok); f.ack(refId);
      await expect(result).resolves.toEqual({refId,ok,error:ok?null:'INTERNAL'});
      await f.manager.drainEvidence();
      expect(evidence).not.toHaveBeenCalled();
      expect(f.wire.write).toHaveBeenCalledTimes(4);
      expect(vi.getTimerCount()).toBe(0);
    } finally { f.manager.close(); vi.useRealTimers(); }
  });

  it.each([10_000,39_999,40_000,90_000])('uses the original first and late cutoffs without delivering a timer (%d ms)',async at=>{
    const f=await clockedAdapter(), evidence=vi.fn(async()=>{});
    try {
      const result=f.manager.prepareLogin('telegram','account.login',{})(evidence), refId=f.lastId();
      const timeout=expect(result).rejects.toThrow('timeout; outcome unknown');
      f.clock(at);
      f.ack(refId); f.ack(refId);
      await timeout;
      await f.manager.drainEvidence();
      expect(evidence).toHaveBeenCalledTimes(at<40_000?1:0);
      if(at<40_000) expect(evidence).toHaveBeenCalledWith({refId,ok:true,error:null});
      expect(vi.getTimerCount()).toBe(0);
      expect(f.wire.write).toHaveBeenCalledTimes(4);
      expect(f.wire.destroy).not.toHaveBeenCalled();
    } finally { f.manager.close(); vi.useRealTimers(); }
  });

  it.each(['ACK','timer'] as const)('a matching late NACK consumes the slot without evidence (%s first)',async first=>{
    const f=await clockedAdapter(), evidence=vi.fn(async()=>{});
    try {
      const result=f.manager.prepareLogin('telegram','account.logout',{})(evidence), refId=f.lastId();
      const timeout=expect(result).rejects.toThrow('timeout; outcome unknown');
      f.clock(10_000);
      if(first==='timer')vi.advanceTimersByTime(10_000);
      f.ack(refId,false); f.ack(refId,true);
      await timeout;
      await f.manager.drainEvidence();
      expect(evidence).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    } finally { f.manager.close(); vi.useRealTimers(); }
  });

  it.each([39_999,40_000])('does not extend late evidence when the first timer wakes at 34 seconds (%d ms)',async at=>{
    const f=await clockedAdapter(), evidence=vi.fn(async()=>{});
    try {
      const result=f.manager.prepareLogin('telegram','account.login',{})(evidence), refId=f.lastId();
      const timeout=expect(result).rejects.toThrow('timeout; outcome unknown');
      f.clock(34_000); vi.advanceTimersByTime(10_000); await timeout;
      expect(vi.getTimerCount()).toBe(1);
      f.clock(at); f.ack(refId);
      await f.manager.drainEvidence();
      expect(evidence).toHaveBeenCalledTimes(at<40_000?1:0);
      expect(vi.getTimerCount()).toBe(0);
    } finally { f.manager.close(); vi.useRealTimers(); }
  });

  it('rearms only the unelapsed portion of either window after an early wake',async()=>{
    const f=await clockedAdapter(), evidence=vi.fn(async()=>{});
    try {
      const result=f.manager.prepareLogin('telegram','account.login',{})(evidence), refId=f.lastId();
      const rejected=vi.fn(); void result.catch(rejected);
      f.clock(9_250); await vi.advanceTimersByTimeAsync(10_000);
      f.clock(9_999); await vi.advanceTimersByTimeAsync(749);
      expect(rejected).not.toHaveBeenCalled();
      f.clock(10_000); await vi.advanceTimersByTimeAsync(1);
      expect(rejected).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(1);
      f.clock(39_250); vi.advanceTimersByTime(30_000);
      expect(vi.getTimerCount()).toBe(1);
      f.clock(39_999); vi.advanceTimersByTime(749);
      expect(vi.getTimerCount()).toBe(1);
      f.clock(40_000); vi.advanceTimersByTime(1);
      expect(vi.getTimerCount()).toBe(0);
      f.ack(refId);
      await f.manager.drainEvidence();
      expect(evidence).not.toHaveBeenCalled();
    } finally { f.manager.close(); vi.useRealTimers(); }
  });

  it('does not retain a slot when a delayed timeout runs after both windows have ended',async()=>{
    const f=await clockedAdapter(), evidence=vi.fn(async()=>{});
    try {
      const timeout=expect(f.manager.prepareLogin('telegram','account.login',{})(evidence)).rejects.toThrow('timeout; outcome unknown');
      const refId=f.lastId();
      f.clock(41_000); vi.advanceTimersByTime(10_000); await timeout;
      expect(vi.getTimerCount()).toBe(0);
      f.ack(refId);
      await f.manager.drainEvidence();
      expect(evidence).not.toHaveBeenCalled();
    } finally { f.manager.close(); vi.useRealTimers(); }
  });

  it.each(['ack','close'] as const)('respects the first synchronous observation if the write then throws (%s)',async first=>{
    const f=await clockedAdapter(), evidence=vi.fn(async()=>{});
    try {
      const prepared=f.manager.prepareLogin('telegram','account.login',{});
      f.clock(60_000); // Time before local write does not consume the first window.
      f.wire.write.mockImplementationOnce((bytes:Uint8Array)=>{
        const refId=read(bytes).id;
        f.clock(69_999);
        if(first==='close')f.link.close();
        f.ack(refId);
        if(first==='ack')f.link.close();
        throw Error('synthetic write failure');
      });
      const result=prepared(evidence);
      if(first==='ack')await expect(result).resolves.toMatchObject({ok:true,error:null});
      else await expect(result).rejects.toThrow('disconnected; outcome unknown');
      expect(vi.getTimerCount()).toBe(0);
      expect(f.wire.write).toHaveBeenCalledTimes(4);
      expect(evidence).not.toHaveBeenCalled();
    } finally { f.manager.close(); vi.useRealTimers(); }
  });

  it('rechecks the same session after fetching the transport write method',async()=>{
    const f=await clockedAdapter();
    const attemptedWrite=vi.fn();
    try {
      const prepared=f.manager.prepareLogin('telegram','account.login',{});
      Object.defineProperty(f.wire,'write',{get(){ f.manager.stopAdmission(); return attemptedWrite; }});
      expect(()=>prepared()).toThrow('CHANNEL_UNAVAILABLE');
      expect(attemptedWrite).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    } finally { f.manager.close(); vi.useRealTimers(); }
  });

  it('drains late evidence admitted on a live session even when admission freezes and the link closes',async()=>{
    const f=await clockedAdapter();
    let finish!:()=>void;
    const held = new Promise<void>(resolve=>{finish=resolve;});
    const evidence=vi.fn(()=>held), drained=vi.fn();
    try {
      const timeout=expect(f.manager.prepareLogin('telegram','account.login',{})(evidence)).rejects.toThrow('timeout; outcome unknown');
      const refId=f.lastId();
      f.manager.stopAdmission();
      f.clock(39_999); f.ack(refId);
      f.clock(40_000); f.manager.close();
      const draining=f.manager.drainEvidence().then(drained);
      await timeout;
      await Promise.resolve();
      expect(evidence).toHaveBeenCalledExactlyOnceWith({refId,ok:true,error:null});
      expect(drained).not.toHaveBeenCalled();
      finish(); await draining;
      expect(drained).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    } finally { finish(); f.manager.close(); vi.useRealTimers(); }
  });

  it('accepts an exact late positive ACK once on the same live connection only', async () => {
    vi.useFakeTimers();
    let elapsed = 0;
    const manager=new AdapterManager({onEvent:async()=>{},onDisconnect:async()=>{}},5,()=>elapsed);
    try {
      const s=socket(), connection=manager.attach('telegram',s);
      startup(connection,'telegram'); await vi.advanceTimersByTimeAsync(0);
      const evidence=vi.fn(async()=>{});
      const run=manager.prepareLogin('telegram','account.login',{});
      const rejected=expect(run(evidence)).rejects.toThrow('timeout; outcome unknown');
      expect(()=>run()).toThrow('CHANNEL_UNAVAILABLE');
      const command=read(s.write.mock.calls[3]![0]);
      elapsed = 5; await vi.advanceTimersByTimeAsync(5); await rejected;
      connection.data(frame('ack',{refId:id(90),ok:true,error:null},10));
      const late=frame('ack',{refId:command.id,ok:true,error:null},11);
      connection.data(late); connection.data(late);
      await manager.drainEvidence();
      expect(evidence).toHaveBeenCalledOnce();
      expect(evidence).toHaveBeenCalledWith({refId:command.id,ok:true,error:null});

      const dropped=vi.fn(async()=>{});
      const timeout=expect(manager.prepareLogin('telegram','account.logout',{})(dropped)).rejects.toThrow('timeout; outcome unknown');
      const oldCommand=read(s.write.mock.calls[4]![0]);
      elapsed = 10; await vi.advanceTimersByTimeAsync(5); await timeout;
      const replacement=manager.attach('telegram',socket()); startup(replacement,'telegram'); await vi.advanceTimersByTimeAsync(0);
      const oldAck=frame('ack',{refId:oldCommand.id,ok:true,error:null},12);
      connection.data(oldAck); replacement.data(oldAck);
      await manager.drainEvidence(); expect(dropped).not.toHaveBeenCalled();
    } finally { manager.close(); vi.useRealTimers(); }
  });
});
