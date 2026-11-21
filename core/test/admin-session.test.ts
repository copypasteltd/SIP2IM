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

it('logout invalidates an admitted authentication before its query returns', async () => {
  const auth = deferred<string | null>();
  const registry = new AdminSessions(() => auth.promise);
  const attached = vi.fn(), socket = fakeSocket();
  const session = registry.open(socket, attached);
  const first = session.message(JSON.stringify({ type: 'auth', token: 'token' }));
  await Promise.resolve();
  registry.revokeToken('token');
  auth.resolve('admin');
  await first;
  expect(socket.closed).toEqual([4403]);
  expect(attached).not.toHaveBeenCalled();
});

it('closes admission immediately and drains accepted auth and queued messages',async()=>{
  vi.useFakeTimers();
  const auth=deferred<string|null>();
  const authenticate=vi.fn(()=>auth.promise);
  const registry=new AdminSessions(authenticate), socket=fakeSocket(), rejected=fakeSocket();
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
  await vi.advanceTimersByTimeAsync(6000);
  expect(finished).toBe(false);
  expect(socket.closed).toEqual([]);
  auth.resolve('admin');
  await Promise.all([first,second,stopping]);
  expect(attached).toHaveBeenCalledTimes(1);
  expect(socket.sent.map(s=>JSON.parse(s))).toEqual([{type:'pong'}]);
  expect(socket.closed).toEqual([1001]);
  expect(detached).toHaveBeenCalledTimes(1);
  session.close();
  expect(detached).toHaveBeenCalledTimes(1);
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
