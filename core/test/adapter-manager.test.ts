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
    expect(manager.loginStep('telegram')).toEqual({step:'code',qrPngBase64:null,hint:null});
    expect(()=>manager.prepareLogin('telegram','account.login.submit',{step:'phone',value:'fake'})).toThrow('BAD_MESSAGE');
    const prepared=manager.prepareLogin('telegram','account.login.submit',{step:'code',value:'fake'});
    connection.data(account('logged_in',5,'changed'));
    expect(()=>prepared()).toThrow(AdapterAdmissionRejected);
    await tick(); expect(manager.loginStep('telegram')).toBeNull();
    expect(()=>prepared()).toThrow('CHANNEL_UNAVAILABLE');
    expect(a.write).toHaveBeenCalledTimes(5);
    const again=manager.prepareLogin('telegram','account.logout',{});
    const b=socket(); startup(manager.attach('telegram',b),'telegram','login_pending'); await tick();
    expect(()=>again()).toThrow('CHANNEL_UNAVAILABLE');
    expect(manager.loginStep('telegram')).toBeNull(); expect(b.write).toHaveBeenCalledTimes(3);
    manager.close();
  });

  it('accepts an exact late positive ACK once on the same live connection only', async () => {
    vi.useFakeTimers();
    const manager=new AdapterManager({onEvent:async()=>{},onDisconnect:async()=>{}},5);
    try {
      const s=socket(), connection=manager.attach('telegram',s);
      startup(connection,'telegram'); await vi.advanceTimersByTimeAsync(0);
      const evidence=vi.fn(async()=>{});
      const run=manager.prepareLogin('telegram','account.login',{});
      const rejected=expect(run(evidence)).rejects.toThrow('timeout; outcome unknown');
      expect(()=>run()).toThrow('CHANNEL_UNAVAILABLE');
      const command=read(s.write.mock.calls[3]![0]);
      await vi.advanceTimersByTimeAsync(5); await rejected;
      connection.data(frame('ack',{refId:id(90),ok:true,error:null},10));
      const late=frame('ack',{refId:command.id,ok:true,error:null},11);
      connection.data(late); connection.data(late);
      await manager.drainEvidence();
      expect(evidence).toHaveBeenCalledOnce();
      expect(evidence).toHaveBeenCalledWith({refId:command.id,ok:true,error:null});

      const dropped=vi.fn(async()=>{});
      const timeout=expect(manager.prepareLogin('telegram','account.logout',{})(dropped)).rejects.toThrow('timeout; outcome unknown');
      const oldCommand=read(s.write.mock.calls[4]![0]);
      await vi.advanceTimersByTimeAsync(5); await timeout;
      const replacement=manager.attach('telegram',socket()); startup(replacement,'telegram'); await vi.advanceTimersByTimeAsync(0);
      const oldAck=frame('ack',{refId:oldCommand.id,ok:true,error:null},12);
      connection.data(oldAck); replacement.data(oldAck);
      await manager.drainEvidence(); expect(dropped).not.toHaveBeenCalled();
    } finally { manager.close(); vi.useRealTimers(); }
  });
});
