// Reads and notifications happen after the commit and can race later transitions.
// Use invalidations rather than asserting an online/offline transition from a stale read.
type DevicePresence={online:boolean;enabled:boolean};
type Read=(id:string)=>Promise<DevicePresence|null>;
type Publish=(type:string,data:unknown)=>Promise<void>;
export async function publishDevicePresence(id:string,_becameOnline:boolean,read:Read,publish:Publish):Promise<void>{
  const device=await read(id);
  if(device)await publish('device.updated',device);
}
export async function publishOfflinePresence(id:string,read:Read,publish:Publish):Promise<void>{
  const device=await read(id);
  if(device)await publish('device.updated',device);
}
