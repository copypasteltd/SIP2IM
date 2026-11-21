export type DevicePatch = {name?:string;enabled?:boolean;callEnabled?:boolean;defaultSimId?:string|null;expectedName?:string};

/** Serializes admin mutations per device within this process, not across Core instances. */
export function createDeviceAdminOperations(deps:{
  update(id:string,patch:DevicePatch):Promise<boolean|'conflict'|{id:string;name:string}>;
  revoke(id:string):Promise<boolean>;
  get(id:string):Promise<unknown|null>;
  revokeSession(id:string,code?:4010|4011):void;
  revokeMedia(id:string):void;
}) {
  const pending=new Map<string,Promise<void>>();
  const unconfirmedTeardown = new Map<string, unknown>();
  function run<T>(id:string,operation:()=>Promise<T>):Promise<T> {
    const previous=pending.get(id)??Promise.resolve();
    const result=previous.then(operation);
    // A rejected operation must release its successor and its key.
    const tail=result.then(()=>{},()=>{});
    pending.set(id,tail);
    void tail.then(()=>{if(pending.get(id)===tail)pending.delete(id);});
    return result;
  }
  function revokeConnections(id:string,code?:4010|4011):void {
    const errors:unknown[]=[];
    try { deps.revokeSession(id,code); } catch(error) { errors.push(error); }
    try { deps.revokeMedia(id); } catch(error) { errors.push(error); }
    if (!errors.length) return;
    const failure = errors.length === 1 ? errors[0] : new AggregateError(errors, 'device connection revocation failed');
    if (!unconfirmedTeardown.has(id)) unconfirmedTeardown.set(id, failure);
    throw failure;
  }
  async function mutateAndRevoke(id:string,mutation:()=>Promise<boolean>,code?:4010|4011):Promise<boolean> {
    let ok=false; let failed=false; let primary:unknown;
    try { ok=await mutation(); } catch(error) { failed=true; primary=error; }
    try { revokeConnections(id,code); } catch(cleanupError) {
      if(failed)throw new AggregateError([primary,cleanupError],'device mutation and connection revocation failed');
      throw cleanupError;
    }
    if(failed)throw primary;
    return ok;
  }
  return {
    updateDevice:(id:string,patch:DevicePatch)=>run(id,async()=>{
      const ok=patch.enabled===false
        ? await mutateAndRevoke(id,async()=>await deps.update(id,patch)===true,4011)
        : await deps.update(id,patch);
      if(ok==='conflict')return {error:'DEVICE_NAME_CONFLICT' as const};
      if(!ok)return null;
      if(typeof ok==='object')return ok;
      return deps.get(id);
    }),
    revokeDevice:(id:string)=>run(id,()=>mutateAndRevoke(id,()=>deps.revoke(id))),
    // The caller has already committed a durable cancellation and revoked the credential.
    teardownRevokedDevice:(id:string)=>run(id,async()=>{
      // A failed close can already have removed the handle. Only a clean process
      // restart establishes that a later attempt no longer needs that handle.
      if (unconfirmedTeardown.has(id)) throw unconfirmedTeardown.get(id);
      revokeConnections(id,4010);
    })
  };
}
