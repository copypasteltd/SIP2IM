import {createRecorder,toneFrame} from './probe.mjs';
export async function initiateCall({deviceId,simId,to,post}){
 const response=await post('/internal/probe/call',{deviceId,simId,to});const data=response?.data ?? response;const leg=data?.browserLeg;
 if(!leg || typeof leg.mediaPath!=='string' || !leg.mediaPath.startsWith('/ws/media?') || typeof leg.mediaToken!=='string' || !leg.mediaToken)throw Error('probe response has no browser media leg');return leg;
}
export function createProbeSession({send,clock=Date.now}){
 const recorder=createRecorder();let sequence=0,authenticated=false;
 return {authenticate(token){if(authenticated)throw Error('already authenticated');if(!token)throw Error('missing media token');send(JSON.stringify({type:'auth',token}));authenticated=true;},sendTone(){if(!authenticated)throw Error('not authenticated');send(toneFrame(sequence++ >>> 0,clock()>>>0));},receive(frame){recorder.accept(frame);},report:()=>recorder.report(),wav:()=>recorder.wav()};
}
