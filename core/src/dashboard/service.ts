import {canCall,canCommand,type Device,type Observation} from '../devices/status.js';
import type {DashboardSnapshot,DashboardStatus} from './repo.js';

export interface DashboardSource { snapshot():Promise<DashboardSnapshot> }
export class DashboardService {
  constructor(private readonly source:DashboardSource, private readonly clock:()=>number=Date.now) {}
  async get() {
    const snapshot=await this.source.snapshot(); const now=this.clock();
    const levels:{L1:number;L2:number;L3:number;L4:number;L5:number}={L1:0,L2:0,L3:0,L4:0,L5:0};
    const devices={total:snapshot.devices.length,online:0,offline:0,paused:0,byLevel:levels};
    const sims={total:snapshot.sims.length,ready:0,numberKnown:0,needsReview:0};
    const capability={smsReady:0,callReady:0,inCall:0};
    const byDevice = new Map<string, Map<string, DashboardStatus>>();
    for (const observed of snapshot.statuses) {
      let fields = byDevice.get(observed.deviceId);
      if (!fields) {
        fields = new Map();
        byDevice.set(observed.deviceId, fields);
      }
      fields.set(observed.field, observed);
    }
    const status = (deviceId: string, field: string) => byDevice.get(deviceId)?.get(field);
    const observation=(item:DashboardStatus|undefined, probe=false):Observation<string>|undefined=>{
      if(!item)return undefined; if(new Date(item.observedAt).getTime()>new Date(item.receivedAt).getTime() || (probe && (new Date(item.observedAt).getTime()<0 || new Date(item.observedAt).getTime()>now)))return undefined; const value=probe && item.value && typeof item.value==='object' ? (item.value as {result?:unknown}).result : item.value;
      return typeof value==='string'?{value,observedAt:new Date(item.observedAt).getTime(),ttlSec:item.ttlSec}:undefined;
    };
    const simReady=(sim:DashboardSnapshot['sims'][number])=>{const at=sim.lastSeenAt == null ? NaN : new Date(sim.lastSeenAt).getTime(); return sim.state==='ready' && Number.isFinite(at) && at>=0 && at<=now && now-at<=7200000;};
    const readyByDevice = new Map<string, number>();
    for (const sim of snapshot.sims) {
      if (simReady(sim)) {
        sims.ready++;
        readyByDevice.set(sim.deviceId, (readyByDevice.get(sim.deviceId) ?? 0) + 1);
      }
      if (sim.numberKnown) sims.numberKnown++;
      if (sim.needsReview) sims.needsReview++;
    }
    for(const d of snapshot.devices){
      d.online?devices.online++:devices.offline++; if(d.paused)devices.paused++;
      if(d.capabilityLevel && Object.hasOwn(levels,d.capabilityLevel)) levels[d.capabilityLevel as keyof typeof levels]++;
      if(d.inCall)capability.inCall++;
      const device:Device={online:d.online,enabled:d.enabled,paused:d.paused,callEnabled:d.callEnabled,capabilityLevel:d.capabilityLevel??'',network:observation(status(d.id,'network')),shizuku:observation(status(d.id,'shizuku')),downlink:observation(status(d.id,'probe.downlink'),true),uplink:observation(status(d.id,'probe.uplink'),true)};
      const permissions=status(d.id,'permissions');
      if(canCommand(device)===null && permissions && permissions.observedAt != null && permissions.receivedAt != null && Number.isFinite(new Date(permissions.observedAt).getTime()) && new Date(permissions.observedAt).getTime()>=0 && new Date(permissions.observedAt).getTime()<=now && new Date(permissions.observedAt).getTime()<=new Date(permissions.receivedAt).getTime() && now<=new Date(permissions.observedAt).getTime()+permissions.ttlSec*1000 && Array.isArray(permissions.value)) {
        const permissionList=permissions.value;
        const granted=(name:string)=>permissionList.some((p:unknown)=>!!p && typeof p==='object' && ((p as {name?:unknown}).name===name || (p as {name?:unknown}).name==='android.permission.'+name) && (p as {granted?:unknown}).granted===true);
        if(granted('SEND_SMS')&&granted('RECEIVE_SMS'))capability.smsReady++;
      }
      if (canCall(device, 'ready', now)) capability.callReady += readyByDevice.get(d.id) ?? 0;
    }
    return {devices,sims,capability,channels:snapshot.channels,alerts:snapshot.alerts};
  }
}
