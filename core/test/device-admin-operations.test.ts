import {describe,expect,it,vi} from 'vitest';
import {createDeviceAdminOperations} from '../src/devices/admin-operations.js';

function deferred<T>() { let resolve!:(value:T)=>void; let reject!:(error:unknown)=>void; const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no;}); return {promise,resolve,reject}; }

describe('device admin operations',()=>{
  it('returns the committed rename without a later device list',async()=>{
    const list=vi.fn(async()=>{throw Error('list unavailable');});
    const ops=createDeviceAdminOperations({update:async()=>({id:'a',name:'new'}),revoke:async()=>true,get:list,revokeSession:()=>{},revokeMedia:()=>{}});
    expect(await ops.updateDevice('a',{name:'new',expectedName:'old'})).toEqual({id:'a',name:'new'});
    expect(list).not.toHaveBeenCalled();
  });
  it('finishes disable revocation before re-enable, while other devices proceed',async()=>{
    const gate=deferred<boolean>(); const events:string[]=[];
    const ops=createDeviceAdminOperations({
      update:vi.fn(async(id,patch)=>{events.push('update:'+id+':'+patch.enabled); if(id==='a'&&patch.enabled===false)return gate.promise; return true;}),
      revoke:async()=>true,get:async id=>({id}),
      revokeSession:(id,code)=>{events.push('session:'+id+':'+code);},revokeMedia:id=>{events.push('media:'+id);}
    });
    const disable=ops.updateDevice('a',{enabled:false});
    const enable=ops.updateDevice('a',{enabled:true});
    const other=ops.updateDevice('b',{enabled:true});
    await other;
    expect(events).toEqual(['update:a:false','update:b:true']);
    gate.resolve(true); await Promise.all([disable,enable]);
    expect(events).toEqual(['update:a:false','update:b:true','session:a:4011','media:a','update:a:true']);
  });
  it('orders revoke and patch in both directions and tears down missing devices',async()=>{
    const gate=deferred<boolean>(); const events:string[]=[];
    const ops=createDeviceAdminOperations({update:async(id)=>{events.push('patch:'+id);return id!=='missing';},revoke:async(id)=>{events.push('revoke:'+id);return id==='a'?gate.promise:id!=='missing';},get:async id=>id==='a'?{id}:null,revokeSession:id=>{events.push('session:'+id);},revokeMedia:id=>{events.push('media:'+id);}});
    const revoke=ops.revokeDevice('a'); const patch=ops.updateDevice('a',{enabled:true});
    await vi.waitFor(()=>expect(events).toEqual(['revoke:a']));
    gate.resolve(true); await Promise.all([revoke,patch]);
    expect(events).toEqual(['revoke:a','session:a','media:a','patch:a']);
    expect(await ops.updateDevice('missing',{enabled:false})).toBeNull();
    expect(await ops.revokeDevice('missing')).toBe(false);
    expect(events.slice(-6)).toEqual(['patch:missing','session:missing','media:missing','revoke:missing','session:missing','media:missing']);
  });
  it.each(['disable','revoke'] as const)('cleans up on an uncertain %s commit and preserves nested errors',async action=>{
    const commitError=new Error('commit outcome unknown'); const releaseError=new Error('release failed');
    const databaseError=new AggregateError([commitError,releaseError],'database failure');
    const sessionError=new Error('session failure'); const mediaError=new Error('media failure'); const events:string[]=[];
    const mutation=async()=>{events.push('database');throw databaseError;};
    const ops=createDeviceAdminOperations({update:mutation,revoke:mutation,get:async()=>{throw new Error('unexpected list');},
      revokeSession:(_id,code)=>{events.push('session:'+code);throw sessionError;},
      revokeMedia:()=>{events.push('media');throw mediaError;}});
    const error=await (action==='disable'?ops.updateDevice('a',{enabled:false}):ops.revokeDevice('a')).catch(error=>error);
    if (!(error instanceof AggregateError)) throw new Error('Expected an aggregate revocation failure');
    expect(error.errors[0]).toBe(databaseError);
    expect(error.errors[0]).toMatchObject({ errors: [commitError, releaseError] });
    expect(error.errors[1]).toBeInstanceOf(AggregateError);
    expect(error.errors[1]).toMatchObject({ errors: [sessionError, mediaError] });
    expect(events).toEqual(['database',action==='disable'?'session:4011':'session:undefined','media']);
  });
  it.each(['disable','revoke'] as const)('retries %s teardown after a committed mutation returns false',async action=>{
    let calls=0; const events:string[]=[]; const sessionError=new Error('session failed');
    const mutation=async()=>++calls===1;
    const ops=createDeviceAdminOperations({update:mutation,revoke:mutation,get:async id=>id==='a'?{id}:null,
      revokeSession:(_id,code)=>{events.push('session:'+code);if(calls===1)throw sessionError;},
      revokeMedia:()=>{events.push('media');}});
    const invoke=()=>action==='disable'?ops.updateDevice('a',{enabled:false}):ops.revokeDevice('a');
    await expect(invoke()).rejects.toBe(sessionError);
    expect(await invoke()).toBe(action==='disable'?null:false);
    expect(events).toEqual([action==='disable'?'session:4011':'session:undefined','media',action==='disable'?'session:4011':'session:undefined','media']);
  });
  it('does not tear down connections for unrelated failed updates',async()=>{
    const failure=new Error('update failed'); const session=vi.fn(); const media=vi.fn();
    const ops=createDeviceAdminOperations({update:async()=>{throw failure;},revoke:async()=>false,get:async()=>null,revokeSession:session,revokeMedia:media});
    await expect(ops.updateDevice('a',{name:'new'})).rejects.toBe(failure);
    expect(session).not.toHaveBeenCalled(); expect(media).not.toHaveBeenCalled();
  });
  it('waits for a patch to finish before revoking the same device',async()=>{
    const gate=deferred<boolean>(); const events:string[]=[];
    const ops=createDeviceAdminOperations({update:async()=>{events.push('patch');return gate.promise;},revoke:async()=>{events.push('revoke');return true;},get:async id=>id==='a'?{id}:null,revokeSession:()=>{events.push('session');},revokeMedia:()=>{events.push('media');}});
    const patch=ops.updateDevice('a',{enabled:false}); const revoke=ops.revokeDevice('a');
    await vi.waitFor(()=>expect(events).toEqual(['patch'])); gate.resolve(true);
    await Promise.all([patch,revoke]);
    expect(events).toEqual(['patch','session','media','revoke','session','media']);
  });
  it('releases queued and future operations when a database or revocation effect throws',async()=>{
    const gate=deferred<boolean>(); const events:string[]=[]; let failEffect=false;
    const ops=createDeviceAdminOperations({update:async(id,patch)=>{events.push('update:'+patch.enabled); if(patch.enabled===false)return gate.promise; return true;},revoke:async()=>true,get:async id=>id==='a'?{id}:null,revokeSession:()=>{events.push('session');if(failEffect){failEffect=false;throw new Error('session failed');}},revokeMedia:()=>{events.push('media');}});
    const failed=ops.updateDevice('a',{enabled:false}); const rejected=expect(failed).rejects.toThrow('database failed');
    const next=ops.updateDevice('a',{enabled:true}); gate.reject(new Error('database failed')); await rejected; await next;
    failEffect=true; await expect(ops.revokeDevice('a')).rejects.toThrow('session failed');
    await expect(ops.revokeDevice('a')).resolves.toBe(true);
    expect(events).toEqual(['update:false','session','media','update:true','session','media','session','media']);
  });
  it('does not confirm cancellation after a local socket teardown failed', async () => {
    const failure = new Error('Socket teardown failed');
    const revokeSession = vi.fn().mockImplementationOnce(() => { throw failure; });
    const ops = createDeviceAdminOperations({ update: async () => false, revoke: async () => false,
      get: async () => null, revokeSession, revokeMedia: () => {} });
    await expect(ops.teardownRevokedDevice('a')).rejects.toBe(failure);
    await expect(ops.teardownRevokedDevice('a')).rejects.toBe(failure);
    expect(revokeSession).toHaveBeenCalledTimes(1);
    await expect(ops.teardownRevokedDevice('b')).resolves.toBeUndefined();
  });
  it('cleans up a separately committed cancellation without writing the device again', async () => {
    const events: string[] = [];
    const revoke = vi.fn(async () => true);
    const ops = createDeviceAdminOperations({ update: async () => true, revoke, get: async () => null,
      revokeSession: (id, code) => { events.push(id + ':' + code); },
      revokeMedia: id => { events.push('media:' + id); } });
    await ops.teardownRevokedDevice('a');
    expect(events).toEqual(['a:4010', 'media:a']);
    expect(revoke).not.toHaveBeenCalled();
  });
});
