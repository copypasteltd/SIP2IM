import {it,expect,vi} from 'vitest';
import type pg from 'pg';
import {recordPlatformDialAck} from '../src/calls/outbound-ack.js';
import {persistCallDeviceEvent} from '../src/calls/device-events.js';
import {reconcileCalls} from '../src/calls/reconcile.js';

function fake(){
 const db={state:'cell_dialing',leg:'dialing',ack:'pending',intent:'none',events:[] as string[],observed:[] as string[]};
 const client={release:vi.fn(),query:vi.fn(async(sql:string,args:unknown[]=[])=>{
  if(sql.startsWith('SELECT 1 FROM call_identity_quarantine')||sql.startsWith('SELECT 1 FROM call_session s JOIN call_event'))return {rowCount:0,rows:[]};
  if(sql.startsWith('SELECT id,kind,state,device_id'))return {rowCount:1,rows:[{id:'ses',kind:'platform_out',state:db.state,device_id:'dev'}]};
  if(sql.startsWith('SELECT call_id,command_id'))return {rowCount:1,rows:[{call_id:'cal',command_id:'cmd',ack_state:db.ack}]};
  if(sql.startsWith('SELECT state FROM call_leg'))return {rowCount:1,rows:[{state:db.leg}]};
  if(sql.startsWith('SELECT s.id,s.kind'))return {rowCount:1,rows:[{id:'ses',kind:'platform_out',state:db.state,leg_id:'leg',leg_state:db.leg}]};
  if (sql.startsWith("SELECT id,state,kind='web_out'")) {
   expect(sql).toContain("state NOT IN ('ended','unknown')");
   expect(sql).toContain("a.callback_intent='quarantined'");
   expect(sql).toContain('FOR UPDATE OF s');
   const unresolved = !['ended', 'unknown'].includes(db.state) || db.ack === 'pending' || db.intent === 'quarantined';
   return { rowCount: Number(unresolved), rows: unresolved ? [{ id: 'ses', state: db.state, unarmed: false }] : [] };
  }
  if(sql.startsWith('UPDATE call_leg'))db.leg=args[1] as string;
  if(sql.startsWith('UPDATE call_session'))db.state=args[2] as string;
  if(sql.startsWith('UPDATE call_outbound_attempt')){
   if(sql.includes("ack_state='ok'")){db.ack='ok';db.intent='quarantined';}
   else if(sql.includes("ack_state='error'")){db.ack='error';db.intent='none';}
   else if(sql.includes("ack_state='unknown',")){db.ack='unknown';db.intent='unknown';}
   else {if(db.ack==='pending')db.ack='unknown';if(db.intent==='quarantined')db.intent='unknown';}
  }
  if(sql.includes("'dial_ack_observed'")){const result=String(args[3]);if(!db.observed.includes(result))db.observed.push(result);}
  else if(sql.startsWith('INSERT INTO call_event'))db.events.push(sql.includes("'dial_ack_conflict'")?'dial_ack_conflict':String(args[2]));
  return {rowCount:1,rows:[],command:sql};
 })};
 return {db,client,pool:{connect:async()=>client} as unknown as pg.Pool};
}
const active={id:'evt_active',type:'call.state',ts:1,payload:{callId:'cal',state:'active',cause:null}};
it('persists early active and handles a duplicate ACK once without sending',async()=>{
 const f=fake();await persistCallDeviceEvent(f.client as unknown as pg.PoolClient,'dev',active);
 expect(f.db.state).toBe('cell_dialing');expect(f.db.leg).toBe('active');
 expect(await recordPlatformDialAck(f.pool,'ses','dev','cmd',true)).toBe('recorded');
 expect(f.db.state).toBe('unknown');expect(f.db.intent).toBe('quarantined');
 expect(await recordPlatformDialAck(f.pool,'ses','dev','cmd',true)).toBe('duplicate');
 expect(f.db.events.filter(x=>x==='state:unknown')).toHaveLength(1);
});
it('does not erase active evidence with a late dialing event',async()=>{
 const f=fake();await persistCallDeviceEvent(f.client as unknown as pg.PoolClient,'dev',active);
 await persistCallDeviceEvent(f.client as unknown as pg.PoolClient,'dev',{...active,id:'evt_late',payload:{...active.payload,state:'dialing'}});
 expect(f.db.leg).toBe('active');
});
it('restart turns unconfirmed attempts unknown and a late ACK cannot advance them',async()=>{
 const f=fake();await persistCallDeviceEvent(f.client as unknown as pg.PoolClient,'dev',active);
 await reconcileCalls(f.pool);expect(f.db.state).toBe('unknown');expect(f.db.ack).toBe('unknown');
 expect(await recordPlatformDialAck(f.pool,'ses','dev','cmd',true)).toBe('ignored');expect(f.db.intent).toBe('none');
});
it('restart invalidates a recorded callback marker',async()=>{
 const f=fake();await recordPlatformDialAck(f.pool,'ses','dev','cmd',true);await reconcileCalls(f.pool);
 expect(f.db.intent).toBe('unknown');expect(f.db.state).toBe('unknown');
});
it('failed ACK after active is uncertain and never records a callback',async()=>{
 const f=fake();await persistCallDeviceEvent(f.client as unknown as pg.PoolClient,'dev',active);
 expect(await recordPlatformDialAck(f.pool,'ses','dev','cmd',false)).toBe('recorded');
 expect(f.db.state).toBe('unknown');expect(f.db.intent).toBe('none');
});
it('failed ACK before active enters ending and cannot trigger callback',async()=>{
 const f=fake();await recordPlatformDialAck(f.pool,'ses','dev','cmd',false);
 expect(f.db.state).toBe('ending');expect(f.db.intent).toBe('none');
});
it('rejects ACKs for unrelated commands',async()=>{
 const f=fake();expect(await recordPlatformDialAck(f.pool,'ses','dev','other',true)).toBe('ignored');expect(f.db.state).toBe('cell_dialing');
});

it('conflicting duplicate ACKs quarantine the outcome',async()=>{
 const f=fake();await recordPlatformDialAck(f.pool,'ses','dev','cmd',true);
 expect(await recordPlatformDialAck(f.pool,'ses','dev','cmd',false)).toBe('conflict');
 expect(f.db.state).toBe('unknown');expect(f.db.ack).toBe('unknown');expect(f.db.intent).toBe('unknown');
});
it('active after ACK remains unattributed and cannot bridge',async()=>{
 const f=fake();await recordPlatformDialAck(f.pool,'ses','dev','cmd',true);
 await persistCallDeviceEvent(f.client as unknown as pg.PoolClient,'dev',active);
 expect(f.db.state).toBe('unknown');expect(f.db.intent).toBe('unknown');
});
it('restart invalidates quarantined evidence even for ended sessions',async()=>{
 const f=fake();f.db.state='ended';f.db.ack='ok';f.db.intent='quarantined';
 await reconcileCalls(f.pool);expect(f.db.state).toBe('ended');expect(f.db.intent).toBe('unknown');
});

it.each(['unknown','ended'])('records contradictory ACK while session remains %s',async state=>{
 const f=fake();f.db.ack='ok';f.db.state=state;f.db.intent='quarantined';
 expect(await recordPlatformDialAck(f.pool,'ses','dev','cmd',false)).toBe('conflict');
 expect(f.db.state).toBe(state);expect(f.db.ack).toBe('unknown');expect(f.db.intent).toBe('unknown');
 expect(f.db.events).toContain('dial_ack_conflict');
});

it.each(['unknown','ended'])('retains distinct late ACK observations while session remains %s',async state=>{
 const f=fake();f.db.state=state;f.db.ack='unknown';
 expect(await recordPlatformDialAck(f.pool,'ses','dev','cmd',true)).toBe('ignored');
 await recordPlatformDialAck(f.pool,'ses','dev','cmd',true);
 await recordPlatformDialAck(f.pool,'ses','dev','cmd',false);
 expect(f.db.observed).toEqual(['ok','error']);expect(f.db.state).toBe(state);
 expect(f.db.ack).toBe('unknown');expect(f.db.intent).toBe('none');
});
