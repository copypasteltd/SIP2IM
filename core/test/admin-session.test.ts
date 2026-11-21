import {afterEach,expect,it,vi} from 'vitest';
import {AdminSessions,openAdminSession} from '../src/ws-admin/session.js';

function deferred<T>() {
  let resolve!:(value:T)=>void;
  const promise=new Promise<T>(done=>{resolve=done;});
  return {promise,resolve};
}
function fakeSocket() {
  const closed:number[]=[],sent:string[]=[];
  return {closed,sent,send:(s:string)=>sent.push(s),close:(c:number)=>closed.push(c)};
}
afterEach(()=>vi.useRealTimers());

it('requires valid first-message token and responds to ping',async()=>{
  const socket=fakeSocket();
  const fail=openAdminSession(socket,async()=>null);
  await fail.message(JSON.stringify({type:'auth',token:'invalid'}));
  expect(socket.closed).toEqual([4403]);
  fail.close();
  const good=openAdminSession(socket,async token=>token==='valid'?'admin':null);
  await good.message(JSON.stringify({type:'auth',token:'valid'}));
  await good.message(JSON.stringify({type:'ping'}));
  expect(JSON.parse(socket.sent[0]!)).toEqual({type:'pong'});
  good.close();
});

const fixtureAuth = JSON.stringify({type:'auth',token:'fixture-session'});
const ping = JSON.stringify({type:'ping'});

// Advance the sampled clock independently of timer delivery, as when the loop is busy.
it.each(['entry', 'queued'] as const)('rejects an expired first message before starting authentication (%s)', async phase => {
  vi.useFakeTimers({toFake:['setTimeout','clearTimeout']});
  let now = 40;
  const authenticate = vi.fn(async () => 'admin');
  const socket = fakeSocket(), attached = vi.fn(), detached = vi.fn();
  const registry = new AdminSessions(authenticate, () => now);
  const session = registry.open(socket, attached, detached);
  now += 4999;
  const queued = phase === 'queued' ? session.message(fixtureAuth) : undefined;
  now++;
  await (queued ?? session.message(fixtureAuth));
  await session.message(ping);
  expect(authenticate).not.toHaveBeenCalled();
  expect(attached).not.toHaveBeenCalled();
  expect(detached).toHaveBeenCalledOnce();
  expect(socket.closed).toEqual([4401]);
  expect(socket.sent).toEqual([]);
  expect(vi.getTimerCount()).toBe(0);
  await registry.stop();
  expect(socket.closed).toEqual([4401]);
});

it.each(['valid', 'refused', 'failure'] as const)('uses timeout when the first auth settles at the deadline (%s)', async outcome => {
  vi.useFakeTimers({toFake:['setTimeout','clearTimeout']});
  let now = 25;
  const auth = deferred<void>();
  const authenticate = vi.fn(async () => {
    await auth.promise;
    if (outcome === 'failure') throw Error('synthetic repository failure');
    return outcome === 'valid' ? 'admin' : null;
  });
  const socket = fakeSocket(), attached = vi.fn(), detached = vi.fn();
  const registry = new AdminSessions(authenticate, () => now);
  const session = registry.open(socket, attached, detached);
  const first = session.message(fixtureAuth), next = session.message(ping);
  await Promise.resolve();
  expect(authenticate).toHaveBeenCalledOnce();
  now += 5000;
  auth.resolve(); // No scheduled timer has been run.
  await Promise.all([first, next]);
  expect(authenticate).toHaveBeenCalledOnce();
  expect(attached).not.toHaveBeenCalled();
  expect(detached).toHaveBeenCalledOnce();
  expect(socket.closed).toEqual([4401]);
  expect(socket.sent).toEqual([]);
  expect(vi.getTimerCount()).toBe(0);
  await registry.stop();
});

it('rearms an early wake only for the remaining time and expires a silent socket', async () => {
  vi.useFakeTimers({toFake:['setTimeout','clearTimeout']});
  let now = 10;
  const authenticate = vi.fn(async () => 'admin');
  const socket = fakeSocket(), attached = vi.fn(), detached = vi.fn();
  const registry = new AdminSessions(authenticate, () => now);
  const session = registry.open(socket, attached, detached);
  now += 4250;
  vi.advanceTimersByTime(5000);
  expect(socket.closed).toEqual([]);
  expect(vi.getTimerCount()).toBe(1);
  now += 749;
  vi.advanceTimersByTime(749);
  expect(socket.closed).toEqual([]);
  now++;
  vi.advanceTimersByTime(1);
  expect(socket.closed).toEqual([4401]);
  expect(detached).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
  await session.message(fixtureAuth);
  expect(authenticate).not.toHaveBeenCalled();
  expect(attached).not.toHaveBeenCalled();
  await registry.stop();
});

it('clears the first-auth deadline for a timely authenticated connection', async () => {
  vi.useFakeTimers({toFake:['setTimeout','clearTimeout']});
  let now = 0;
  const authenticate = vi.fn(async () => 'admin');
  const socket = fakeSocket(), attached = vi.fn();
  const registry = new AdminSessions(authenticate, () => now);
  const session = registry.open(socket, attached);
  now = 4999;
  await session.message(fixtureAuth);
  expect(attached).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
  now = 60_000;
  vi.advanceTimersByTime(60_000);
  await session.message(ping);
  expect(authenticate).toHaveBeenCalledTimes(2);
  expect(socket.sent.map(frame=>JSON.parse(frame))).toEqual([{type:'pong'}]);
  expect(socket.closed).toEqual([]);
  await registry.stop();
  expect(socket.closed).toEqual([1001]);
});

it('rejects a pong after confirmed revocation and distinguishes authentication failure', async () => {
  const authenticate = vi.fn(async (): Promise<string | null> => 'admin');
  const registry = new AdminSessions(authenticate);
  const socket = fakeSocket();
  const session = registry.open(socket);
  await session.message(JSON.stringify({ type: 'auth', token: 'token' }));
  authenticate.mockResolvedValueOnce(null);
  await session.message(JSON.stringify({ type: 'ping' }));
  expect(socket.sent).toEqual([]);
  expect(socket.closed).toEqual([4403]);

  const other = fakeSocket();
  const connected = registry.open(other);
  await connected.message(JSON.stringify({ type: 'auth', token: 'token' }));
  authenticate.mockRejectedValueOnce(new Error('database unavailable'));
  await connected.message(JSON.stringify({ type: 'ping' }));
  expect(other.sent).toEqual([]);
  expect(other.closed).toEqual([1011]);
});

it.each(['token', 'all', 'transport'] as const)('does not override an earlier close with a late auth result (%s)', async how => {
  vi.useFakeTimers({toFake:['setTimeout','clearTimeout']});
  let now = 0;
  const auth = deferred<string|null>();
  const authenticate = vi.fn(() => auth.promise);
  const registry = new AdminSessions(authenticate, () => now);
  const socket = fakeSocket(), attached = vi.fn(), detached = vi.fn();
  const session = registry.open(socket, attached, detached);
  const first = session.message(fixtureAuth), next = session.message(ping);
  await Promise.resolve();
  expect(authenticate).toHaveBeenCalledOnce();
  if (how === 'token') registry.revokeToken('fixture-session');
  else if (how === 'all') registry.revokeAll();
  else session.close();
  now = 6000;
  auth.resolve('admin');
  await Promise.all([first,next,registry.stop()]);
  expect(authenticate).toHaveBeenCalledOnce();
  expect(attached).not.toHaveBeenCalled();
  expect(detached).toHaveBeenCalledOnce();
  expect(socket.closed).toEqual(how === 'transport' ? [] : [4403]);
  expect(socket.sent).toEqual([]);
  expect(vi.getTimerCount()).toBe(0);
});

it('closes admission immediately and drains timely auth and admitted ping',async()=>{
  vi.useFakeTimers({toFake:['setTimeout','clearTimeout']});
  let now = 0;
  const auth=deferred<string|null>(), recheck=deferred<string|null>(), pingStarted=deferred<void>();
  const authenticate=vi.fn(() => auth.promise).mockImplementationOnce(() => auth.promise).mockImplementationOnce(() => {
    pingStarted.resolve();
    return recheck.promise;
  });
  const registry=new AdminSessions(authenticate,()=>now), socket=fakeSocket(), rejected=fakeSocket();
  const attached=vi.fn(), detached=vi.fn();
  const session=registry.open(socket,attached,detached);
  const first=session.message(JSON.stringify({type:'auth',token:'test-token'}));
  const second=session.message(JSON.stringify({type:'ping'}));
  await Promise.resolve();
  expect(authenticate).toHaveBeenCalledTimes(1);
  const stopping=registry.stop();
  expect(registry.stop()).toBe(stopping);
  const late=registry.open(rejected);
  await late.message(JSON.stringify({type:'auth',token:'late'}));
  await session.message(JSON.stringify({type:'ping'}));
  expect(rejected.closed).toEqual([1001]);
  let finished=false;
  void stopping.then(()=>{finished=true;});
  now = 4999;
  await vi.advanceTimersByTimeAsync(4999);
  expect(finished).toBe(false);
  expect(socket.closed).toEqual([]);
  auth.resolve('admin');
  await pingStarted.promise;
  expect(attached).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
  now = 6000;
  await vi.advanceTimersByTimeAsync(1001);
  expect(finished).toBe(false);
  expect(socket.sent).toEqual([]);
  recheck.resolve('admin');
  await Promise.all([first,second,stopping]);
  expect(authenticate).toHaveBeenCalledTimes(2);
  expect(socket.sent.map(s=>JSON.parse(s))).toEqual([{type:'pong'}]);
  expect(socket.closed).toEqual([1001]);
  expect(detached).toHaveBeenCalledTimes(1);
  session.close();
  expect(detached).toHaveBeenCalledTimes(1);
});

it.each(['timer', 'completion'] as const)('keeps first-auth deadline during shutdown and waits for the query (%s)', async firstEffect => {
  vi.useFakeTimers({toFake:['setTimeout','clearTimeout']});
  let now = 0;
  const auth = deferred<string|null>();
  const authenticate = vi.fn(() => auth.promise);
  const socket = fakeSocket(), attached = vi.fn(), detached = vi.fn();
  const registry = new AdminSessions(authenticate, () => now);
  const session = registry.open(socket, attached, detached);
  const first = session.message(fixtureAuth), queuedPing = session.message(ping);
  await Promise.resolve();
  const stopping = registry.stop();
  let drained = false;
  void stopping.then(() => { drained = true; });
  now = 5000;
  if (firstEffect === 'timer') {
    vi.advanceTimersByTime(5000);
    expect(socket.closed).toEqual([4401]);
    expect(detached).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  } else {
    expect(socket.closed).toEqual([]);
  }
  await Promise.resolve();
  expect(drained).toBe(false);
  auth.resolve('admin');
  await Promise.all([first, queuedPing, stopping]);
  expect(drained).toBe(true);
  expect(authenticate).toHaveBeenCalledOnce();
  expect(attached).not.toHaveBeenCalled();
  expect(detached).toHaveBeenCalledOnce();
  expect(socket.closed).toEqual([4401]);
  expect(socket.sent).toEqual([]);
  expect(vi.getTimerCount()).toBe(0);
});

it('drains auth after a socket disconnects without attaching it',async()=>{
  const auth=deferred<string|null>();
  const attached=vi.fn(),detached=vi.fn(),socket=fakeSocket();
  const registry=new AdminSessions(()=>auth.promise);
  const session=registry.open(socket,attached,detached);
  const message=session.message(JSON.stringify({type:'auth',token:'test-token'}));
  await Promise.resolve();
  session.close();
  let finished=false;
  const stopping=registry.stop().then(()=>{finished=true;});
  await Promise.resolve();
  expect(finished).toBe(false);
  auth.resolve('admin');
  await Promise.all([message,stopping]);
  expect(attached).not.toHaveBeenCalled();
  expect(detached).toHaveBeenCalledTimes(1);
  expect(socket.closed).toEqual([]);
});

it('retains socket close failures after the session is detached',async()=>{
  const registry=new AdminSessions(async()=>null);
  const session=registry.open({send:()=>{},close:()=>{throw new Error('private socket detail');}});
  await session.message(JSON.stringify({type:'auth',token:'test-token'}));
  await expect(registry.stop()).rejects.toThrow('admin session shutdown failed');
});

it('does not expose authentication or cleanup errors containing secrets',async()=>{
  const secret='test-secret-value';
  const log=vi.spyOn(console,'error').mockImplementation(()=>{});
  try {
    const socket=fakeSocket();
    const registry=new AdminSessions(async()=>{throw new Error(secret);});
    const session=registry.open(socket,undefined,()=>{throw new Error(secret);});
    await expect(session.message(JSON.stringify({type:'auth',token:secret}))).resolves.toBeUndefined();
    await expect(registry.stop()).rejects.toThrow('admin session shutdown failed');
    expect(log).not.toHaveBeenCalled();
  } finally { log.mockRestore(); }
});
