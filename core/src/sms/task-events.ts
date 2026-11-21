/** Publication is best effort after a committed dispatch transition. */
export async function markSmsAndNotify(mark:()=>Promise<boolean>,notify:()=>Promise<void>,onError:(error:unknown)=>void):Promise<boolean>{const changed=await mark();if(changed)try{await notify();}catch(error){onError(error);}return changed;}
export async function publishTaskAfterCommit(id:string,read:(id:string)=>Promise<unknown|null>,publish:(type:string,data:unknown)=>Promise<void>):Promise<void>{const task=await read(id);if(task)await publish('sms.task.updated',task);}
