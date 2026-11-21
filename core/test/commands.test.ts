import { expect, it, vi } from 'vitest';
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
  commands.acknowledge('other',{refId:id,ok:false,error:'CONFLICT'});
  commands.acknowledge('one',{refId:id,ok:true,error:null});
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
  commands.acknowledge('one',{refId:sms.commandId,ok:true,error:null});
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
  commands.acknowledge('one',{refId:pending.commandId,ok:true,error:null});
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
