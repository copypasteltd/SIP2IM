import {parseDeviceMessage} from '@voipgw/protocol';
import type pg from 'pg';
import {isDeepStrictEqual} from 'node:util';
import {describe, expect, it, vi} from 'vitest';
import {assertSmsCustodyReady, decodeSmsCustody, SMS_QUARANTINE_MARKER, type QuarantineEvidence} from '../src/db/sms-quarantine-custody.js';
import {makeDeviceEventProducer} from '../src/devices/event-producer.js';
import {DeviceEvents} from '../src/devices/events.js';
import {DeviceSessions} from '../src/ws-device/session.js';
import {type InboundSmsCustodyMode} from '../src/devices/inbound-sms.js';
import {type ParsedSmsEnvelope} from '../src/devices/sms-quarantine-envelope.js';

const deviceId = 'dev_00000000000000000000000001';
const otherDevice = 'dev_00000000000000000000000002';
const original: ParsedSmsEnvelope = {
  v: 1, type: 'sms.received', id: 'evt_00000000000000000000000001', ts: 42,
  payload: {subId:null, slot:null, from:'fixture', fromKind:'unknown', body:'fixture', receivedAt:37, parts:1},
};
const exceptional = {...original, payload:{...original.payload, body:'body\0\ud800', parts:2 ** 53}};
const next = {...original, id:'evt_00000000000000000000000002'};
const parsed = (event: ParsedSmsEnvelope) => parseDeviceMessage(event,'event');
type ParentRow = {deviceId: string; type: string; ts: number; payload: unknown};
type ChildRow = QuarantineEvidence & {deviceId: string; linked: boolean};

function memoryPool() {
  let committed = {
    events: new Map<string, ParentRow>(), custody: new Map<string, ChildRow>(),
    history: new Map<string, unknown[]>(), outbox: new Set<string>(), alerts: new Map<string, unknown[]>(),
  };
  const copies = () => ({events:new Map(committed.events),custody:new Map(committed.custody),
    history:new Map(committed.history),outbox:new Set(committed.outbox),alerts:new Map(committed.alerts)});
  const switches = {authorized:true, durable:true, corrupt:false, projectionLimit:false, shouldFail:'', nextCommit:'commit'};
  const calls: Array<{sql:string;args:unknown[]}> = [];
  const connect = vi.fn(async () => {
    let pending = copies();
    const query = async (sql: string, args: unknown[] = []) => {
      calls.push({sql,args});
      const result = (rows:unknown[] = [],rowCount=rows.length) => ({rows,rowCount});
      if (switches.shouldFail && sql.trimStart().startsWith(switches.shouldFail)) {
        throw new Error('fake driver error');
      }
      if (sql === 'BEGIN') {pending = copies(); return result();}
      if (sql === 'ROLLBACK') return {...result(),command:'ROLLBACK'};
      if (sql === 'SAVEPOINT sms_projection') return {...result(),command:'SAVEPOINT'};
      if (sql === 'ROLLBACK TO SAVEPOINT sms_projection') {pending=copies();return {...result(),command:'ROLLBACK'};}
      if (sql === 'COMMIT') {
        const mode = switches.nextCommit;
        switches.nextCommit = 'commit';
        if (mode === 'rollback') return {...result(),command:'ROLLBACK'};
        committed = pending;
        if (mode === 'lost') throw new Error('fake lost reply');
        return {...result(),command:'COMMIT'};
      }
      if (sql.startsWith('SET ')) return result();
      if (sql.startsWith('SELECT NOT pg_is_in_recovery()')) return result([{ready:switches.durable}]);
      if (sql.startsWith('SELECT id FROM device')) return result(switches.authorized ? [{id:args[0]}] : []);
      const key = String(args[0]);
      if (sql.startsWith('INSERT INTO device_event')) {
        if (pending.events.has(key) || (args[2]===SMS_QUARANTINE_MARKER && pending.history.has(key))) return result();
        pending.events.set(key,{deviceId:String(args[1]),type:String(args[2]),ts:(args[4] as Date).getTime(),
          payload:args[2]===SMS_QUARANTINE_MARKER ? {quarantineId:args[3]} : JSON.parse(String(args[3]))});
        return result([{id:key}]);
      }
      if (sql.startsWith('INSERT INTO sms_received_quarantine')) {
        const [,eventId,deviceId,ts,reason,encoding,payload,payloadLength,digest] = args;
        pending.custody.set(String(eventId),{eventId:String(eventId),deviceId:String(deviceId),deviceTsMs:String(ts),
          reason:String(reason),encoding:String(encoding),payload:payload as Buffer,payloadLength:Number(payloadLength),
          digest:digest as Buffer,linked:true});
        return result([],1);
      }
      if (sql.includes('FROM sms_received_quarantine q')) {
        const row = pending.custody.get(key);
        return result(row && row.deviceId === args[1] ? [{...row,linked:!switches.corrupt}] : []);
      }
      if (sql.startsWith('INSERT INTO alert')) {
        pending.alerts.set(String(args.at(-2)),args);
        return result([],1);
      }
      if (sql.startsWith('INSERT INTO sms_message')) {
        if (switches.projectionLimit) throw Object.assign(new Error('tuple width fixture'),{code:'54000',routine:'_bt_check_third_page'});
        if (pending.history.has(String(args[1]))) throw Object.assign(new Error('conflicting history fixture'),
          {code:'23505',constraint:'sms_message_event_id_key'});
        pending.history.set(String(args[1]),[...args.slice(2)]);
        return result([],1);
      }
      if (sql.startsWith('INSERT INTO sms_incoming_admin_outbox')) {
        pending.outbox.add(key);
        return result([],1);
      }
      if (sql.includes('JOIN sms_message')) {
        const event=pending.events.get(key), history=pending.history.get(key);
        return result(event && history ? [{matches:event.deviceId===args[1] && event.type===args[2] &&
          isDeepStrictEqual(event.payload,JSON.parse(String(args[3]))) && event.ts===(args[4] as Date).getTime() &&
          isDeepStrictEqual(history,[args[1],null,...args.slice(5)])}] : []);
      }
      throw new Error('unhandled mock SQL');
    };
    return {query,release:vi.fn()};
  });
  return {pool:{connect} as unknown as pg.Pool,calls,switches,get state(){return committed;}};
}

function ingress(f: ReturnType<typeof memoryPool>, mode?: InboundSmsCustodyMode) {
  const events=new DeviceEvents(f.pool,{smsCustody:mode});
  const incomingSms=vi.fn();
  return {incomingSms,receive:makeDeviceEventProducer({handle:(id,event)=>events.handle(id,event),incomingSms})};
}

describe('recoverable inbound SMS custody, in-memory transaction doubles', () => {
  it('keeps device FIFO ownership by default and records a content-free alert on the current schema',async () => {
    const f=memoryPool(); const port=ingress(f);
    expect(await port.receive(deviceId,parsed(exceptional))).toBe(false);
    expect(f.state.events.size).toBe(0);
    expect(f.state.custody.size).toBe(0);
    expect(f.state.history.size).toBe(0);
    expect(f.state.outbox.size).toBe(0);
    expect(port.incomingSms).not.toHaveBeenCalled();
    expect([...f.state.alerts.values()].map(args=>JSON.parse(String(args.at(-1))))).toEqual([
      {eventId:exceptional.id,reasons:['postgres-invalid-string','parts-out-of-range']},
    ]);
    expect(f.calls.some(({sql})=>sql.includes('sms_received_quarantine'))).toBe(false);
  });

  it('retains the head without acknowledging it in retain mode, then continues after an exact committed retry',async () => {
    const f=memoryPool();
    const fifo=[exceptional,next];
    const sendHead = async (mode: InboundSmsCustodyMode) => {
      const port=ingress(f,mode);
      if (await port.receive(deviceId,parsed(fifo[0]!))) fifo.shift();
      return port.incomingSms;
    };
    expect(await sendHead('retain')).not.toHaveBeenCalled();
    expect(fifo).toEqual([exceptional,next]);
    expect(decodeSmsCustody(f.state.custody.get(exceptional.id)!)).toEqual(exceptional);
    expect(f.state.events.get(exceptional.id)).toMatchObject({deviceId,ts:42,type:SMS_QUARANTINE_MARKER});
    expect(await sendHead('acknowledge')).not.toHaveBeenCalled();
    expect(fifo).toEqual([next]);
    expect(await sendHead('acknowledge')).toHaveBeenCalledTimes(1);
    expect(fifo).toEqual([]);
    expect([...f.state.history.keys()]).toEqual([next.id]);
    expect([...f.state.outbox]).toEqual([next.id]);
    expect(f.state.alerts.size).toBe(1);
  });

  it('converges after an uncertain COMMIT, and rejects changed content, device, and timestamp',async () => {
    const f=memoryPool();const port=ingress(f,'acknowledge');
    f.switches.nextCommit='lost';
    await expect(port.receive(deviceId,parsed(exceptional))).rejects.toThrow('outcome is uncertain');
    expect(port.incomingSms).not.toHaveBeenCalled();
    expect(await ingress(f,'acknowledge').receive(deviceId,parsed(exceptional))).toBe(true);
    expect(await port.receive(otherDevice,parsed(exceptional))).toBe(false);
    expect(await port.receive(deviceId,parsed({...exceptional,ts:43}))).toBe(false);
    expect(await port.receive(deviceId,parsed({...exceptional,payload:{...exceptional.payload,body:'different'}}))).toBe(false);
    expect(await port.receive(deviceId,parsed(original))).toBe(false);
    f.switches.corrupt=true;
    expect(await port.receive(deviceId,parsed(exceptional))).toBe(false);
    expect(f.state.custody.size).toBe(1);
    expect(f.state.history.size).toBe(0);
  });

  it.each(['INSERT INTO sms_received_quarantine','INSERT INTO alert','rolled back'])('withholds ACK when custody cannot commit: %s',async failure => {
    const f=memoryPool(); const port=ingress(f,'acknowledge');
    if (failure==='rolled back') f.switches.nextCommit='rollback';
    else f.switches.shouldFail=failure;
    await expect(port.receive(deviceId,parsed(exceptional))).rejects.toThrow();
    expect(f.state.events.size).toBe(0);
    expect(f.state.custody.size).toBe(0);
    expect(f.state.alerts.size).toBe(0);
    expect(port.incomingSms).not.toHaveBeenCalled();
  });

  it('rolls back the partial projection before retaining a confirmed index-limit event',async () => {
    const f=memoryPool();
    f.switches.projectionLimit=true;
    const port=ingress(f,'acknowledge');
    expect(await port.receive(deviceId,parsed(original))).toBe(true);
    expect(f.calls.findIndex(({sql})=>sql==='ROLLBACK TO SAVEPOINT sms_projection')).toBeLessThan(
      f.calls.findIndex(({sql})=>sql.startsWith('INSERT INTO sms_received_quarantine')));
    const held=f.state.custody.get(original.id);
    expect(held?.reason).toBe('postgres-index-limit');
    expect(decodeSmsCustody(held!)).toEqual(original);
    expect(f.state.history.size).toBe(0);
    expect(f.state.outbox.size).toBe(0);
    f.switches.projectionLimit=false;
    expect(await port.receive(deviceId,parsed(original))).toBe(true);
    expect(port.incomingSms).not.toHaveBeenCalled();
    expect(f.state.custody.size).toBe(1);
    expect(f.state.alerts.size).toBe(1);
  });

  it('sends the existing positive ACK only after a committed custody replay on a new in-memory socket',async () => {
    const f=memoryPool();
    const {receive,incomingSms}=ingress(f,'acknowledge');
    const subject=original;
    const sessions=new DeviceSessions({authenticate:async()=>({id:deviceId,enabled:true}),heartbeat:async()=>{},
      onEvent:(device,event)=>receive(device,event as ReturnType<typeof parseDeviceMessage>),heartbeatSec:30,locale:'en'});
    const connect=async () => {
      const send=vi.fn();const close=vi.fn();const socket=sessions.open({send,close});
      await socket.message(JSON.stringify({v:1,type:'hello',id:'evt_00000000000000000000000003',ts:42,
        payload:{token:'fixture',apkVersion:'fixture',apkCode:1,protocol:1,manufacturer:'fixture',model:'fixture',apiLevel:22,locale:'en'}}));
      return {socket,send,close};
    };
    try {
      const first=await connect();
      f.switches.projectionLimit=true;
      f.switches.nextCommit='lost';
      await first.socket.message(JSON.stringify(subject));
      expect(first.send).toHaveBeenCalledTimes(1);
      expect(first.close).toHaveBeenCalledWith(1011);
      const retry=await connect();
      f.switches.projectionLimit=false;
      await retry.socket.message(JSON.stringify(subject));
      expect(JSON.parse(retry.send.mock.calls.at(-1)![0])).toMatchObject({type:'ack',payload:{refId:subject.id,ok:true,error:null}});
      await retry.socket.message(JSON.stringify(next));
      expect(JSON.parse(retry.send.mock.calls.at(-1)![0])).toMatchObject({type:'ack',payload:{refId:next.id,ok:true,error:null}});
      expect(incomingSms).toHaveBeenCalledTimes(1);
    } finally { await sessions.stop(); }
  });

  it('rechecks local durability on the transaction connection before writing or ACKing custody',async () => {
    const f=memoryPool();const port=ingress(f,'acknowledge');
    f.switches.durable=false;
    expect(await port.receive(deviceId,parsed(exceptional))).toBe(false);
    expect(await port.receive(deviceId,parsed(original))).toBe(false);
    expect(f.state.custody.size).toBe(0);
    expect(f.state.history.size).toBe(0);
    f.switches.durable=true;
    expect(await port.receive(deviceId,parsed(exceptional))).toBe(true);
    f.switches.durable=false;
    expect(await port.receive(deviceId,parsed(exceptional))).toBe(false);
    expect(f.state.custody.size).toBe(1);
  });

  it('requires active device authorization before it writes or reads custody',async () => {
    const f=memoryPool(); f.switches.authorized=false;
    expect(await ingress(f,'acknowledge').receive(deviceId,parsed(exceptional))).toBe(false);
    expect(f.calls.filter(({sql})=>/\b(?:INSERT|JOIN)\b/.test(sql))).toEqual([]);
  });

  it('keeps normal projection exact and will not ACK a missing or conflicting history row',async () => {
    const f=memoryPool();const port=ingress(f);
    const result=await port.receive(deviceId,parsed(original));
    expect(result).toBe(true);
    expect(await port.receive(deviceId,parsed(original))).toBe(true);
    expect(port.incomingSms).toHaveBeenCalledTimes(2);
    expect(f.state.history.size).toBe(1);
    expect(f.state.outbox.size).toBe(1);
    expect(await port.receive(deviceId,parsed({...original,payload:{...original.payload,slot:0}}))).toBe(false);
    expect(await ingress(f,'acknowledge').receive(deviceId,parsed(exceptional))).toBe(false);
    f.state.history.delete(original.id);
    expect(await port.receive(deviceId,parsed(original))).toBe(false);
    expect(port.incomingSms).toHaveBeenCalledTimes(2);
  });

  it('reports an orphaned history row and rolls back the tentative event without claiming custody',async () => {
    const f=memoryPool(); const port=ingress(f,'acknowledge');
    const history = ['preexisting'];
    f.state.history.set(original.id,history);
    expect(await port.receive(deviceId,parsed(original))).toBe(false);
    expect(await port.receive(deviceId,parsed(exceptional))).toBe(false);
    expect(f.state.history.get(original.id)).toEqual(history);
    expect(f.state.events.size).toBe(0);
    expect(f.state.custody.size).toBe(0);
    expect(f.state.outbox.size).toBe(0);
    expect([...f.state.alerts.values()].map(args=>JSON.parse(String(args.at(-1))))).toEqual([
      {eventId:original.id,reasons:['event-id-conflict']},
    ]);
  });

  it('rolls back normal ingest when its history or notification insert fails',async () => {
    for (const sql of ['INSERT INTO sms_message','INSERT INTO sms_incoming_admin_outbox']) {
      const f=memoryPool(); f.switches.shouldFail=sql;
      const port=ingress(f);
      await expect(port.receive(deviceId,parsed(original))).rejects.toThrow();
      expect(f.state.events.size).toBe(0);
      expect(f.state.history.size).toBe(0);
      expect(port.incomingSms).not.toHaveBeenCalled();
    }
  });

  it('starts custody only on affirmative schema and durability preflight evidence',async () => {
    const query=vi.fn(async (sql:string)=>({rows:[{ready:true}]}));
    const pool={query} as unknown as pg.Pool;
    await expect(assertSmsCustodyReady(pool)).resolves.toBeUndefined();
    expect(query.mock.calls[0]?.[0]).toContain('pg_is_in_recovery');
    expect(query.mock.calls[0]?.[0]).toContain("current_setting('fsync')='on'");
    expect(query.mock.calls[0]?.[0]).toContain('version=23');
    query.mockResolvedValueOnce({rows:[{ready:false}]});
    await expect(assertSmsCustodyReady(pool)).rejects.toThrow('SMS_CUSTODY_NOT_READY');
    query.mockRejectedValueOnce(Error('driver detail'));
    await expect(assertSmsCustodyReady(pool)).rejects.toThrow(/^SMS_CUSTODY_NOT_READY$/);
  });
});
