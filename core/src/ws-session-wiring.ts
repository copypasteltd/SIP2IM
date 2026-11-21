import type {WebSocket} from 'ws';

interface Session { message(raw:string):Promise<void>; close():void }

/** Install transport error handling before opening a device or admin session. */
export function wireSessionSocket(socket:WebSocket, open:()=>Session, reportError:()=>void=()=>{}):void {
  let session:Session | undefined;
  let closed=false;
  let detached=false;
  const detach=()=>{
    closed=true;
    if (!session || detached) return;
    detached=true;
    try { session.close(); } catch { /* Session registries record cleanup failures. */ }
  };
  const fail=()=>{
    if (closed) return;
    detach();
    try { reportError(); } catch { /* Reporting must not prevent cleanup. */ }
    try { socket.terminate(); } catch { /* The transport may already be gone. */ }
  };
  socket.on('error',fail);
  socket.on('close',detach);
  try { session=open(); } catch { fail(); return; }
  if (closed) { detach(); return; }
  socket.on('message',data=>{
    if (closed) return;
    try { void session!.message(data.toString()).catch(fail); } catch { fail(); }
  });
}
