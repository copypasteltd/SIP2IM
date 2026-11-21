import {EventEmitter} from 'node:events';
import type {WebSocket} from 'ws';
import {describe,expect,it,vi} from 'vitest';
import {wireSessionSocket} from '../src/ws-session-wiring.js';

class FakeSocket extends EventEmitter {
  terminate=vi.fn();
}
const asSocket=(socket:FakeSocket)=>socket as unknown as WebSocket;

describe.each(['/ws/device','/ws/admin'])('%s transport wiring',()=>{
  it('reproduces unhandled errors without a listener',()=>{
    const socket=new FakeSocket();
    expect(()=>socket.emit('error',new Error('broken'))).toThrow('broken');
  });
  it('detaches and terminates once on error, including a subsequent close',()=>{
    const socket=new FakeSocket(),session={close:vi.fn(),message:vi.fn(async()=>{})};
    const report=vi.fn(()=>{throw new Error('logger failed');});
    wireSessionSocket(asSocket(socket),()=>session,report);
    socket.emit('message',Buffer.from('hello'));
    expect(session.message).toHaveBeenCalledWith('hello');
    expect(()=>socket.emit('error',new Error('broken'))).not.toThrow();
    socket.emit('error',new Error('again'));
    socket.emit('close');
    socket.emit('message',Buffer.from('late'));
    expect(session.close).toHaveBeenCalledOnce();
    expect(socket.terminate).toHaveBeenCalledOnce();
    expect(report).toHaveBeenCalledOnce();
    expect(session.message).toHaveBeenCalledOnce();
  });
  it('handles errors raised during open and still detaches the returned session',()=>{
    const socket=new FakeSocket(),session={close:vi.fn(),message:vi.fn(async()=>{})};
    wireSessionSocket(asSocket(socket),()=>{socket.emit('error',new Error('early'));return session;});
    socket.emit('close');
    expect(session.close).toHaveBeenCalledOnce();
    expect(socket.terminate).toHaveBeenCalledOnce();
  });
  it('handles reentrant close and failures during cleanup',()=>{
    const socket=new FakeSocket();
    const session={close:vi.fn(()=>{socket.emit('close');throw new Error('detach');}),message:vi.fn(async()=>{})};
    socket.terminate.mockImplementation(()=>{throw new Error('terminate');});
    wireSessionSocket(asSocket(socket),()=>session);
    expect(()=>socket.emit('error',new Error('broken'))).not.toThrow();
    expect(session.close).toHaveBeenCalledOnce();
    expect(socket.terminate).toHaveBeenCalledOnce();
  });
  it('cleans up when open throws',()=>{
    const socket=new FakeSocket(),report=vi.fn();
    expect(()=>wireSessionSocket(asSocket(socket),()=>{throw new Error('open');},report)).not.toThrow();
    socket.emit('error',new Error('late'));
    expect(report).toHaveBeenCalledOnce();
    expect(socket.terminate).toHaveBeenCalledOnce();
  });
  it.each(['sync','async'])('cleans up after a %s message failure',async kind=>{
    const socket=new FakeSocket(),report=vi.fn();
    const session={close:vi.fn(),message:vi.fn(()=>{
      if (kind==='sync') throw new Error('message');
      return Promise.reject(new Error('message'));
    })};
    wireSessionSocket(asSocket(socket),()=>session,report);
    expect(()=>socket.emit('message',Buffer.from('hello'))).not.toThrow();
    await vi.waitFor(()=>expect(socket.terminate).toHaveBeenCalledOnce());
    socket.emit('close'); socket.emit('error',new Error('late'));
    expect(session.close).toHaveBeenCalledOnce();
    expect(report).toHaveBeenCalledOnce();
  });
  it('does not terminate on ordinary close or a late error',()=>{
    const socket=new FakeSocket(),session={close:vi.fn(),message:vi.fn(async()=>{})};
    wireSessionSocket(asSocket(socket),()=>session);
    socket.emit('close');socket.emit('error',new Error('late'));
    expect(session.close).toHaveBeenCalledOnce();
    expect(socket.terminate).not.toHaveBeenCalled();
  });
});
