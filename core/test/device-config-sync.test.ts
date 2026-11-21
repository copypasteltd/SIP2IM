import { readFile } from 'node:fs/promises';
import { expect, it, vi } from 'vitest';
import { DeviceConfigSync, type ConfigAttachment, type DeviceConfig } from '../src/settings/device-config.js';
import { DeviceCommands } from '../src/ws-device/commands.js';
import { DeviceSessions } from '../src/ws-device/session.js';

const initial: DeviceConfig = { heartbeatSec: 30, locale: 'en' };
const next: DeviceConfig = { heartbeatSec: 45, locale: 'zh-HK' };
const ack = { ok: true, error: null } as const;
const negative = { ok: false, error: 'BAD_MESSAGE' } as const;
const defer = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; };
const turn = () => new Promise<void>(resolve => setImmediate(resolve));

function fixture() {
  let at = 0, admitted = true;
  const read = vi.fn(async () => initial);
  const report = vi.fn();
  const attachments: ConfigAttachment[] = [];
  const sync = new DeviceConfigSync(read, () => attachments, () => { if (!admitted) throw new Error('not owner'); }, report, () => at);
  const target = (deviceId: string) => ({ deviceId, current: vi.fn(() => true), send: vi.fn<ConfigAttachment['send']>().mockResolvedValue(ack) });
  return { sync, read, attachments, target, report, at(value: number) { at = value; }, revoke() { admitted = false; } };
}

it('drops an obsolete read at the commit boundary and coalesces several invalidations', async () => {
  const f = fixture(); const target = f.target('one'); f.attachments.push(target);
  const blocked = defer<DeviceConfig>();
  f.read.mockReturnValueOnce(blocked.promise).mockResolvedValue(next);
  const active = f.sync.refresh();
  await turn();
  expect(f.sync.refresh()).toBe(active);
  f.sync.invalidate(); f.sync.invalidate(); f.sync.invalidate();
  blocked.resolve(initial);
  await active;
  expect(f.read).toHaveBeenCalledTimes(2);
  expect(target.send).toHaveBeenCalledExactlyOnceWith(next, expect.any(Function));
  await f.sync.refresh();
  expect(target.send).toHaveBeenCalledTimes(1);
});

it('reads confirmed settings, never a request payload, and recovers from failed and invalid readback', async () => {
  const f = fixture(); const target = f.target('one');
  await f.sync.refresh();
  expect(f.read).not.toHaveBeenCalled();
  f.attachments.push(target);
  f.read.mockRejectedValueOnce(new Error('offline DB')).mockResolvedValueOnce({ ...initial, heartbeatSec: 86_401 }).mockResolvedValue(next);
  await f.sync.refresh(); await f.sync.refresh();
  expect(f.report).toHaveBeenCalledTimes(2);
  expect(target.send).not.toHaveBeenCalled();
  await f.sync.refresh();
  expect(target.send).toHaveBeenCalledExactlyOnceWith(next, expect.any(Function));
});

it('paces unknown and negative ACKs without delaying a newly read configuration or resending confirmed targets', async () => {
  const f = fixture(); const one = f.target('one'), two = f.target('two'), three = f.target('three');
  f.attachments.push(one, two, three);
  two.send.mockRejectedValueOnce(new Error('timeout'));
  three.send.mockResolvedValueOnce(negative).mockResolvedValueOnce({ ok: true, error: 'BAD_MESSAGE' });
  await f.sync.refresh();
  f.at(29_999); await f.sync.refresh();
  for (const target of [one, two, three]) expect(target.send).toHaveBeenCalledTimes(1);
  f.at(30_000); await f.sync.refresh();
  expect(one.send).toHaveBeenCalledTimes(1);
  expect(two.send).toHaveBeenCalledTimes(2);
  expect(three.send).toHaveBeenCalledTimes(2);
  f.read.mockResolvedValue(next);
  // A changed target value bypasses the existing retry delay.
  await f.sync.refresh();
  for (const target of [one, two, three]) expect(target.send).toHaveBeenLastCalledWith(next, expect.any(Function));
});

it('does not reuse an old confirmation after an intervening write with an uncertain outcome', async () => {
  const f = fixture(); const target = f.target('one'); f.attachments.push(target);
  await f.sync.refresh();
  const blocked = defer<typeof ack>();
  target.send.mockReturnValueOnce(blocked.promise);
  f.read.mockResolvedValue(next);
  const writing = f.sync.refresh();
  await turn();
  expect(target.send.mock.calls.map(([config]) => config)).toEqual([initial, next]);
  const outdatedGuard = target.send.mock.calls.at(-1)![1];
  f.read.mockResolvedValue(initial); f.sync.invalidate();
  expect(outdatedGuard()).toBe(false);
  blocked.resolve(ack); // Results after invalidation do not settle a new epoch.
  await writing;
  expect(target.send.mock.calls.map(([config]) => config)).toEqual([initial, next, initial]);
});

it('drains one bounded batch at a time and gives later devices a turn even while early devices retry', async () => {
  const f = fixture();
  const targets = Array.from({length: 19}, (_, i) => f.target('device-' + String(i).padStart(2, '0')));
  const gate = defer<typeof negative>();
  for (const target of targets.slice(0, 8)) target.send.mockReturnValueOnce(gate.promise);
  f.attachments.push(...targets);
  const work = f.sync.refresh(); await turn();
  expect(f.sync.refresh()).toBe(work);
  expect(targets.filter(target => target.send.mock.calls.length)).toEqual(targets.slice(0, 8));
  gate.resolve(negative); await work;
  f.at(31_000); await f.sync.refresh();
  expect(targets.filter(target => target.send.mock.calls.length)).toEqual(targets.slice(0, 16));
  expect(targets[0]!.send).toHaveBeenCalledTimes(1);
  await f.sync.refresh();
  expect(targets.every(target => target.send.mock.calls.length)).toBe(true);
});

it('continues past the previous batch when its cursor device detaches before the next pass', async () => {
  const f = fixture();
  const targets = Array.from({length: 17}, (_, i) => f.target('device-' + String(i).padStart(2, '0')));
  for (const target of targets.slice(0, 8)) target.send.mockResolvedValue(negative);
  f.attachments.push(...targets);
  await f.sync.refresh();
  expect(targets[7]!.send).toHaveBeenCalledOnce();
  // A disconnection deletes the cursor. Reconnects may also reorder the registry.
  f.attachments.splice(0, f.attachments.length, ...targets.filter((_, i) => i !== 7).reverse());
  f.at(31_000); await f.sync.refresh();
  for (const target of targets.slice(8, 16)) expect(target.send).toHaveBeenCalledOnce();
  expect(targets[0]!.send).toHaveBeenCalledOnce();
  await f.sync.refresh();
  expect(targets[16]!.send).toHaveBeenCalledOnce();
});

it('awaits admitted writes on stop and never dispatches after authority is lost during a read', async () => {
  const f = fixture(); const target = f.target('one'); f.attachments.push(target);
  const read = defer<DeviceConfig>(); f.read.mockReturnValueOnce(read.promise);
  const stale = f.sync.refresh(); await turn(); f.revoke(); read.resolve(initial); await stale;
  expect(target.send).not.toHaveBeenCalled();

  const g = fixture(); const target2 = g.target('two'); g.attachments.push(target2);
  const applying = defer<typeof ack>(); target2.send.mockReturnValueOnce(applying.promise);
  const active = g.sync.refresh(); await turn();
  const drained = vi.fn(); const closing = g.sync.stop().then(drained);
  g.sync.invalidate(); await g.sync.refresh();
  expect(drained).not.toHaveBeenCalled();
  expect(target2.send.mock.calls[0]?.[1]()).toBe(false);
  applying.resolve(ack); await Promise.all([active, closing]);
  expect(drained).toHaveBeenCalledOnce();
  expect(target2.send).toHaveBeenCalledTimes(1);
});

const deviceId = 'dev_01ARZ3NDEKTSV4RRFFQ69G5FAV';
const eventId = 'evt_01ARZ3NDEKTSV4RRFFQ69G5FAV';
const hello = JSON.stringify({ v: 1, type: 'hello', id: eventId, ts: 1,
  payload: { token: 'fixture', apkVersion: '1', apkCode: 1, protocol: 1, manufacturer: 'Test', model: 'Test', apiLevel: 19, locale: 'en' } });
const receipt = (refId: string) => JSON.stringify({ v: 1, type: 'ack', id: eventId, ts: 1, payload: { refId, ...ack } });
const socket = () => ({ send: vi.fn<(data: string) => void>(), close: vi.fn<(code: number) => void>(), readyState: 1 });

it('sends only after hello, ignores stale-socket ACKs, and uses a fresh command identity on replacement', async () => {
  const commands = new DeviceCommands();
  const sessions = new DeviceSessions({ authenticate: async () => ({ id: deviceId, enabled: true }), heartbeat: async () => {},
    onEvent: async () => true, heartbeatSec: 30, locale: 'en', commands });
  const oldSocket = socket(), newSocket = socket();
  const old = sessions.open(oldSocket), current = sessions.open(newSocket);
  const sync = new DeviceConfigSync(async () => next, () => commands.configAttachments(), () => {});
  const firstWrite = defer<string>(), newWrite = defer<string>();
  oldSocket.send.mockImplementation(data => { if (JSON.parse(data).type === 'config.update') firstWrite.resolve(data); });
  newSocket.send.mockImplementation(data => { if (JSON.parse(data).type === 'config.update') newWrite.resolve(data); });
  try {
    await sync.refresh(); expect(oldSocket.send).not.toHaveBeenCalled();
    await old.message(hello);
    const oldWork = sync.refresh();
    const oldFrame = JSON.parse(await firstWrite.promise);
    expect(oldSocket.send.mock.calls.map(([raw]) => JSON.parse(raw).type)).toEqual(['hello.ok', 'config.update']);
    expect(oldFrame.payload).toEqual(next);
    await current.message(hello); await oldWork;
    const fresh = sync.refresh();
    const frame = JSON.parse(await newWrite.promise);
    expect(frame.id).not.toBe(oldFrame.id);
    const settled = vi.fn(); void fresh.then(settled);
    await old.message(receipt(frame.id)); await current.message(receipt(oldFrame.id)); await turn();
    expect(settled).not.toHaveBeenCalled();
    await current.message(receipt(frame.id)); await fresh;
    await sync.refresh();
    expect(newSocket.send.mock.calls.map(([raw]) => JSON.parse(raw).type)).toEqual(['hello.ok', 'config.update']);
  } finally { await sessions.stop(); await sync.stop(); }
});

it('retries after a lost ACK on the same attachment with a fresh ID and ignores the old receipt', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const commands = new DeviceCommands();
  const sessions = new DeviceSessions({ authenticate: async () => ({ id: deviceId, enabled: true }), heartbeat: async () => {},
    onEvent: async () => true, heartbeatSec: 30, locale: 'en', commands });
  const wire = socket(), session = sessions.open(wire);
  let now = 0;
  const sync = new DeviceConfigSync(async () => next, () => commands.configAttachments(), () => {}, undefined, () => now);
  const writes = () => wire.send.mock.calls.map(([raw]) => JSON.parse(raw)).filter(frame => frame.type === 'config.update');
  try {
    await session.message(hello);
    const first = sync.refresh(); await turn();
    const firstId = writes()[0]?.id;
    expect(firstId).toEqual(expect.any(String));
    await vi.advanceTimersByTimeAsync(10_000); await first;
    now = 29_999; await sync.refresh();
    expect(writes()).toHaveLength(1);
    now = 30_000;
    const second = sync.refresh(); await turn();
    expect(writes()).toHaveLength(2);
    const secondId = writes()[1].id;
    expect(secondId).not.toBe(firstId);
    const settled = vi.fn(); void second.then(settled);
    await session.message(receipt(firstId)); await turn();
    expect(settled).not.toHaveBeenCalled();
    await session.message(receipt(secondId)); await second;
    await sync.refresh(); expect(writes()).toHaveLength(2);
  } finally { await sessions.stop(); await sync.stop(); vi.useRealTimers(); }
});

it('rechecks generation and config admission at send time, including after attachment replacement', async () => {
  const current = socket(), replacement = socket();
  let sendAllowed = true;
  const commands = new DeviceCommands(() => { sendAllowed = false; });
  commands.attach(deviceId, current);
  expect(commands.configAttachments()).toEqual([]);
  commands.configReady(deviceId, current);
  const old = commands.configAttachments()[0]!;
  await expect(old.send(initial, () => sendAllowed)).rejects.toThrow('disconnected');
  expect(current.send).not.toHaveBeenCalled();
  commands.attach(deviceId, replacement);
  commands.configReady(deviceId, current);
  expect(commands.configAttachments()).toEqual([]);
  await expect(old.send(initial, () => true)).rejects.toThrow('disconnected');
  current.readyState = 3;
  commands.configReady(deviceId, replacement);
  expect(commands.configAttachments()).toHaveLength(1);
  expect(replacement.send).not.toHaveBeenCalled();
  await expect(commands.send(deviceId, 'config.update', initial)).rejects.toThrow('eligible attachment');
});

it('wires authoritative readback, commit invalidation, retry tick, and a drained stop into Core', async () => {
  const source = await readFile(new URL('../src/main.ts', import.meta.url), 'utf8');
  expect(source).toMatch(/new DeviceConfigSync\(async \(\) => \{\s*const \{ heartbeatSec, botLocale \} = await settingsRepo\.get\(\);/);
  expect(source).toMatch(/await settingsRepo\.update\(patch, expected\);[\s\S]*?deviceConfigSync\.invalidate\(\)/);
  expect(source).toContain("transactionOutcome(error);\n      if (outcome && (Object.hasOwn(patch, 'heartbeatSec') || Object.hasOwn(patch, 'botLocale'))) deviceConfigSync.invalidate();");
  expect(source).toContain('()=>stopping.aborted ? undefined : deviceConfigSync.refresh(),');
  expect(source).toContain('transportLifecycle.defer(() => deviceConfigSync.stop(), { critical: true });');
  expect(source).not.toContain("commands.broadcast('config.update'");
});
