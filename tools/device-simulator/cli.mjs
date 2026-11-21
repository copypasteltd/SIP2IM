import {readFile} from 'node:fs/promises';
import {attachDeviceSocket,bindDevice,createSession} from './runner.mjs';
import {openDeviceMedia} from './media.mjs';
import WebSocket from 'ws';
const args=process.argv.slice(2); const option=name=>{const i=args.indexOf(name);return i<0?undefined:args[i+1];};
const count=Number(option('--count')), server=option('--server'), file=option('--bind-codes');
if(!Number.isInteger(count)||count<1||!server||!file) throw Error('usage: --count N --server ws://host --bind-codes file');
const codes=(await readFile(file,'utf8')).split(/\r?\n/).map(x=>x.trim()).filter(Boolean);if(codes.length<count)throw Error('not enough binding codes');
for(let i=0;i<count;i++){
 const {token,deviceId}=await bindDevice(server,codes[i]);
 const url=new URL(server);url.pathname='/ws/device';url.search='';
 let socket,detach,closed=false,delay=1000,timer;
 const session=createSession({token,deviceId,simCount:i%2+1,openMedia:leg=>openDeviceMedia({server,leg,token,WebSocketImpl:WebSocket})});
 function connect(){
  const port=new WebSocket(url);
  socket=port;
  detach=attachDeviceSocket(session,port,{
   onOpen:()=>{if(socket===port)delay=1000;},
   onClose:({code})=>{
    if(!closed && socket===port && ![4003,4005,4010,4011].includes(code)){
     timer=setTimeout(connect,delay);delay=Math.min(delay*2,30000);
    }
   },
  });
 }
 connect();
 process.once('SIGINT',()=>{closed=true;clearTimeout(timer);detach();socket.close();console.log(JSON.stringify({deviceId,...session.report()}));});
}
