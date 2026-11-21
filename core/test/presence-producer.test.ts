import {it,expect,vi} from 'vitest';
import {publishDevicePresence,publishOfflinePresence} from '../src/devices/presence-producer.js';

it('treats heartbeat and sweep as invalidations regardless of the later state',async()=>{
  let state={id:'dev',online:true,enabled:true};
  const read=async()=>({...state});
  const publish=vi.fn(async(_type:string,_data:unknown)=>{});
  // A disable commits after heartbeat, before the heartbeat's post-commit read.
  state={...state,online:false,enabled:false};
  await publishDevicePresence('dev',true,read,publish);
  // A heartbeat commits after the sweep, before the sweep's post-commit read.
  state={...state,online:true,enabled:true};
  await publishOfflinePresence('dev',read,publish);
  expect(publish.mock.calls.map(c=>c[0])).toEqual(['device.updated','device.updated']);
  expect(publish.mock.calls[0]![1]).toMatchObject({online:false,enabled:false});
  expect(publish.mock.calls[1]![1]).toMatchObject({online:true,enabled:true});
});

it('remains an invalidation when a delayed broadcast follows a newer one',async()=>{
  let release!:()=>void;const gate=new Promise<void>(r=>{release=r;});
  let entered!:()=>void;const started=new Promise<void>(r=>{entered=r;});
  const delivered:string[]=[];
  const old=publishDevicePresence('dev',true,async()=>({online:true,enabled:true}),async(type)=>{entered();await gate;delivered.push(type);});
  await started;
  await publishOfflinePresence('dev',async()=>({online:false,enabled:true}),async(type)=>{delivered.push(type);});
  release();await old;
  expect(delivered).toEqual(['device.updated','device.updated']);
});

it('suppresses notifications for a revoked or missing device',async()=>{
  const publish=vi.fn(async()=>{});
  await publishDevicePresence('dev',true,async()=>null,publish);
  await publishOfflinePresence('dev',async()=>null,publish);
  expect(publish).not.toHaveBeenCalled();
});
