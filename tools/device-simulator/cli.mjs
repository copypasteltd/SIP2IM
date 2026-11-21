import {readFile} from 'node:fs/promises';
import {bindDevice,createSession} from './runner.mjs';
import {openDeviceMedia} from './media.mjs';
import WebSocket from 'ws';
const args=process.argv.slice(2); const option=name=>{const i=args.indexOf(name);return i<0?undefined:args[i+1];};
const count=Number(option('--count')), server=option('--server'), file=option('--bind-codes');
if(!Number.isInteger(count)||count<1||!server||!file) throw Error('usage: --count N --server ws://host --bind-codes file');
const codes=(await readFile(file,'utf8')).split(/\r?\n/).map(x=>x.trim()).filter(Boolean);if(codes.length<count)throw Error('not enough binding codes');
const sessions=[];
for(let i=0;i<count;i++){
 const {token,deviceId}=await bindDevice(server,codes[i]);
 const url=new URL(server);url.pathname='/ws/device';url.search='';let socket,closed=false,delay=1000,timer;
 const session=createSession({token,simCount:i%2+1,send:message=>socket.send(message),openMedia:leg=>openDeviceMedia({server,leg,token,WebSocketImpl:WebSocket})});sessions.push({deviceId,session});
 function connect(){socket=new WebSocket(url);socket.addEventListener('open',()=>{delay=1000;session.start();});socket.addEventListener('message',e=>{if(typeof e.data==='string')session.receive(e.data);});socket.addEventListener('close',e=>{session.close();if(!closed && ![4003,4005,4010,4011].includes(e.code)){timer=setTimeout(connect,delay);delay=Math.min(delay*2,30000);}});socket.addEventListener('error',()=>{});}
 connect();const heartbeat=setInterval(()=>session.heartbeat(),30000);
 process.once('SIGINT',()=>{closed=true;clearTimeout(timer);clearInterval(heartbeat);session.close();socket.close();console.log(JSON.stringify({deviceId,...session.report()}));});
}
