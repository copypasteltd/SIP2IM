import { afterEach, expect, it, vi } from 'vitest';
import { ulid } from 'ulid';

vi.mock('ulid', async importOriginal => {
  const original = await importOriginal<typeof import('ulid')>();
  return { ...original, ulid: vi.fn(original.ulid) };
});
afterEach(() => { vi.mocked(ulid).mockReset(); vi.useRealTimers(); });
import { DeviceCommands } from '../src/ws-device/commands.js';
import { isSmsCommandId } from '../src/sms/attempt-id.js';

const payload = {taskId:'tsk_01ARZ3NDEKTSV4RRFFQ69G5FAV', slot:0, subId:null, to:'test', body:'fake'};
const socket = () => ({send:vi.fn<(frame:string)=>void>(),close:vi.fn()});

it('correlates ordinary ACKs only from the target device and rejects on disconnect', async () => {
  const s = socket();
  const commands = new DeviceCommands();
  commands.attach('one',s);
  const first = commands.send('one','probe.run',{items:[]});
  const id = JSON.parse(s.send.mock.calls[0]![0]).id;
  expect(isSmsCommandId(id)).toBe(false);
  commands.acknowledge('other',s,{refId:id,ok:false,error:'CONFLICT'});
  commands.acknowledge('one',socket(),{refId:id,ok:false,error:'CONFLICT'});
  commands.acknowledge('one',s,{refId:id,ok:true,error:null});
  expect(await first).toEqual({ok:true,error:null});
  const second = commands.send('one','probe.run',{items:[]});
  commands.detach('one',s);
  await expect(second).rejects.toThrow('disconnected');
});

it('prepares a wire-compatible SMS identity and emits it at most once', async () => {
  const s = socket();
  const commands = new DeviceCommands();
  commands.attach('one',s);
  const sms = commands.prepareSms('one',payload)!;
  expect(isSmsCommandId(sms.commandId)).toBe(true);
  expect(s.send).not.toHaveBeenCalled();
  await expect(commands.send('one','sms.send',payload)).rejects.toThrow('prepared command');
  const sent = sms.send();
  const frame = JSON.parse(s.send.mock.calls[0]![0]);
  expect(frame).toMatchObject({type:'sms.send',id:sms.commandId,payload});
  expect(frame.ts).toBeLessThan(2 ** 48 - 1);
  commands.acknowledge('one',s,{refId:sms.commandId,ok:true,error:null});
  expect(await sent).toEqual({ok:true,error:null});
  await expect(sms.send()).rejects.toThrow('already been attempted');
  expect(s.send).toHaveBeenCalledOnce();
});

it('rejects a stale preparation and a pending ACK on socket replacement', async () => {
  const commands = new DeviceCommands();
  const original = socket(), replacement = socket();
  commands.attach('one',original);
  const pending = commands.prepareSms('one',payload)!;
  const stale = commands.prepareSms('one',payload)!;
  const sent = pending.send();
  commands.attach('one',replacement);
  commands.acknowledge('one',original,{refId:pending.commandId,ok:true,error:null});
  commands.detach('one',original);
  await expect(sent).rejects.toThrow('disconnected');
  await expect(stale.send()).rejects.toThrow('disconnected');
  expect(original.send).toHaveBeenCalledOnce();
  expect(replacement.send).not.toHaveBeenCalled();
});

it('checks egress admission again after the asynchronous claim could have completed', async () => {
  let allowed = true;
  const commands = new DeviceCommands(() => { if (!allowed) throw new Error('ownership lost'); });
  const s = socket();
  commands.attach('one',s);
  const sms = commands.prepareSms('one',payload)!;
  allowed = false;
  await expect(sms.send()).rejects.toThrow('ownership lost');
  await expect(commands.send('one','probe.run',{items:[]})).rejects.toThrow('ownership lost');
  expect(s.send).not.toHaveBeenCalled();
});

const ack = (refId:string, ok=true) => ({refId,ok,error:ok?null:'CONFLICT'});
const frameId = (wire: ReturnType<typeof socket>) => (JSON.parse(wire.send.mock.calls.at(-1)![0]) as {id:string}).id;

it('accepts a matching ACK just before cutoff and ignores duplicates', async () => {
  vi.useFakeTimers({toFake:['setTimeout','clearTimeout']});
  let now=100;
  const commands=new DeviceCommands(undefined,()=>now), wire=socket();
  commands.attach('one',wire);
  const waiting=commands.send('one','probe.run',{items:[]}), id=frameId(wire);
  now+=9999;
  commands.acknowledge('one',wire,ack(id,false));
  commands.acknowledge('one',wire,ack(id));
  await expect(waiting).resolves.toEqual({ok:false,error:'CONFLICT'});
  expect(vi.getTimerCount()).toBe(0);
});

it.each([true,false])('settles an ACK at the exact cutoff as timeout before the timer runs (ok=%s)', async ok => {
  vi.useFakeTimers({toFake:['setTimeout','clearTimeout']});
  let now=0;
  const commands=new DeviceCommands(undefined,()=>now), wire=socket();
  commands.attach('one',wire);
  const waiting=commands.send('one','probe.run',{items:[]}), id=frameId(wire);
  const timedOut=expect(waiting).rejects.toThrow('timeout');
  now=10_000;
  commands.acknowledge('one',socket(),ack(id,ok)); // Not even an expired ACK may settle the wrong socket's attempt.
  expect(vi.getTimerCount()).toBe(1);
  commands.acknowledge('one',wire,ack(id,ok));
  await timedOut;
  commands.acknowledge('one',wire,ack(id));
  expect(vi.getTimerCount()).toBe(0);
  expect(wire.send).toHaveBeenCalledOnce();
});

it('rearms an early wake only for the unelapsed ACK window', async () => {
  vi.useFakeTimers({toFake:['setTimeout','clearTimeout']});
  let now=0;
  const commands=new DeviceCommands(undefined,()=>now), wire=socket();
  commands.attach('one',wire);
  const waiting=commands.send('one','probe.run',{items:[]}), timedOut=expect(waiting).rejects.toThrow('timeout');
  now=9250; vi.advanceTimersByTime(10_000);
  expect(vi.getTimerCount()).toBe(1);
  now=9999; vi.advanceTimersByTime(749);
  expect(vi.getTimerCount()).toBe(1);
  now=10_000; vi.advanceTimersByTime(1);
  await timedOut;
  expect(vi.getTimerCount()).toBe(0);
});

it('ignores a pre-send ACK, then starts the full window and accepts an ACK during send', async () => {
  vi.useFakeTimers({toFake:['setTimeout','clearTimeout']});
  let now=0, ref:string|undefined;
  const wire=socket();
  const commands=new DeviceCommands(()=>{
    if(ref===undefined)return;
    now=40_000;
    commands.acknowledge('one',wire,ack(ref,false));
    expect(wire.send).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  },()=>now);
  commands.attach('one',wire);
  const prepared=commands.prepareSms('one',payload)!;
  ref=prepared.commandId;
  wire.send.mockImplementationOnce(raw=>{
    expect(JSON.parse(raw).id).toBe(ref);
    expect(vi.getTimerCount()).toBe(0);
    now=49_999;
    commands.acknowledge('one',wire,ack(prepared.commandId));
  });
  await expect(prepared.send()).resolves.toEqual({ok:true,error:null});
  await expect(prepared.send()).rejects.toThrow('already been attempted');
  expect(vi.getTimerCount()).toBe(0);
  expect(wire.send).toHaveBeenCalledOnce();
});

it('does not send or arm a deadline for a socket already closing', async () => {
  vi.useFakeTimers({toFake:['setTimeout','clearTimeout']});
  const commands=new DeviceCommands(), wire={...socket(),readyState:2};
  commands.attach('one',wire);
  await expect(commands.send('one','probe.run',{items:[]})).rejects.toThrow('disconnected');
  expect(wire.send).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

it('consumes a prepared call before a reentrant authorization check', async () => {
  vi.useFakeTimers({toFake:['setTimeout','clearTimeout']});
  const commands=new DeviceCommands(undefined,()=>0), wire=socket();
  const generation='gen_01ARZ3NDEKTSV4RRFFQ69G5FAV';
  let submit: (()=>Promise<{ok:boolean;error:string|null}>) | undefined;
  let inner: Promise<{ok:boolean;error:string|null}> | undefined;
  commands.attach('one',wire,{connectionId:generation,current:()=>{
    const reenter=submit;
    submit=undefined;
    if(reenter){inner=reenter(); void inner.catch(()=>{});}
    return true;
  }});
  const prepared=commands.captureCallAttachment('one')!.prepare('call.hangup',{callId:'cal_01ARZ3NDEKTSV4RRFFQ69G5FAV',generation});
  submit=prepared.send;
  wire.send.mockImplementation(raw=>commands.acknowledge('one',wire,ack(JSON.parse(raw).id)));
  await expect(prepared.send()).resolves.toEqual({ok:true,error:null});
  await expect(inner).rejects.toThrow('cannot be submitted');
  expect(wire.send).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});

it.each(['ack','detach'] as const)('keeps the first in-send terminal observation when send later throws (%s)', async first => {
  vi.useFakeTimers({toFake:['setTimeout','clearTimeout']});
  const commands=new DeviceCommands(undefined,()=>0), wire=socket();
  commands.attach('one',wire);
  wire.send.mockImplementationOnce(raw=>{
    if(first==='detach')commands.detach('one',wire);
    commands.acknowledge('one',wire,ack(JSON.parse(raw).id));
    if(first==='ack')commands.detach('one',wire);
    throw Error('synthetic transport failure');
  });
  const sent=commands.send('one','probe.run',{items:[]});
  if(first==='ack')await expect(sent).resolves.toEqual({ok:true,error:null});
  else await expect(sent).rejects.toThrow('disconnected');
  expect(wire.send).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});

it.each(['timer','send failure'] as const)('a retired %s cannot settle a replacement using the same fixture ID', async cause => {
  vi.useFakeTimers({toFake:['setTimeout','clearTimeout']});
  const schedule=vi.spyOn(globalThis,'setTimeout');
  let now=0, newer:Promise<{ok:boolean;error:string|null}>|undefined;
  const commands=new DeviceCommands(undefined,()=>now), old=socket(), fresh=socket();
  const fixtureId='01ARZ3NDEKTSV4RRFFQ69G5FAV';
  vi.mocked(ulid).mockReturnValueOnce(fixtureId).mockReturnValueOnce(fixtureId);
  commands.attach('one',old);
  const replace=()=>{
    commands.attach('one',fresh);
    now=2000;
    newer=commands.send('one','probe.run',{items:[]});
  };
  if(cause==='send failure') old.send.mockImplementationOnce(()=>{
    replace();
    throw Error('synthetic old socket failure');
  });
  try {
    const retired=expect(commands.send('one','probe.run',{items:[]})).rejects.toThrow('disconnected');
    let oldTimer: (()=>void) | undefined;
    if(cause==='timer') {
      oldTimer=schedule.mock.calls[0]?.[0] as () => void;
      expect(oldTimer).toBeTypeOf('function');
      replace();
    }
    await retired;
    expect(frameId(old)).toBe(frameId(fresh));
    now=10_000; oldTimer?.();
    commands.acknowledge('one',old,ack(frameId(old),false));
    expect(vi.getTimerCount()).toBe(1);
    commands.acknowledge('one',fresh,ack(frameId(fresh)));
    await expect(newer).resolves.toEqual({ok:true,error:null});
    expect(vi.getTimerCount()).toBe(0);
  } finally { schedule.mockRestore(); }
});

it.each(['ack','detach'] as const)('method lookup cannot admit an ACK or a retired send (%s)', async action => {
  vi.useFakeTimers({toFake:['setTimeout','clearTimeout']});
  const wire=socket(), commands=new DeviceCommands(undefined,()=>0);
  commands.attach('one',wire);
  const sms=commands.prepareSms('one',payload)!;
  const send=vi.fn(function(this:typeof wire,raw:string){
    expect(this).toBe(wire);
    expect(JSON.parse(raw).id).toBe(sms.commandId);
    commands.acknowledge('one',wire,ack(sms.commandId));
  });
  Object.defineProperty(wire,'send',{get(){
    commands.acknowledge('one',wire,ack(sms.commandId,false));
    if(action==='detach')commands.detach('one',wire);
    return send;
  }});
  if(action==='detach') {
    await expect(sms.send()).rejects.toThrow('disconnected');
    expect(send).not.toHaveBeenCalled();
  } else {
    await expect(sms.send()).resolves.toEqual({ok:true,error:null});
    expect(send).toHaveBeenCalledOnce();
  }
  expect(vi.getTimerCount()).toBe(0);
});

it.each([3500,10_000])('local send time counts against the original timeout (%d ms)', async sendTook => {
  vi.useFakeTimers({toFake:['setTimeout','clearTimeout']});
  let now=0;
  const wire=socket(), commands=new DeviceCommands(undefined,()=>now);
  wire.send.mockImplementationOnce(()=>{now=sendTook;});
  commands.attach('one',wire);
  const timedOut=expect(commands.send('one','probe.run',{items:[]})).rejects.toThrow('timeout');
  if(sendTook<10_000) {
    now=9999; vi.advanceTimersByTime(9999-sendTook);
    expect(vi.getTimerCount()).toBe(1);
    now=10_000; vi.advanceTimersByTime(1);
  }
  expect(vi.getTimerCount()).toBe(0);
  await timedOut;
  expect(wire.send).toHaveBeenCalledOnce();
});

it('keeps separate commands on one socket independent across the earlier deadline', async () => {
  vi.useFakeTimers({toFake:['setTimeout','clearTimeout']});
  let now=0;
  const wire=socket(), commands=new DeviceCommands(undefined,()=>now);
  commands.attach('one',wire);
  const early=commands.send('one','probe.run',{items:[]}), first=frameId(wire);
  const timedOut=expect(early).rejects.toThrow('timeout');
  now=4000;
  const later=commands.send('one','probe.run',{items:[]}), second=frameId(wire);
  expect(second).not.toBe(first);
  now=10_000;
  commands.acknowledge('one',wire,ack(first));
  commands.acknowledge('one',wire,ack(second));
  await timedOut;
  await expect(later).resolves.toEqual({ok:true,error:null});
  expect(vi.getTimerCount()).toBe(0);
});
