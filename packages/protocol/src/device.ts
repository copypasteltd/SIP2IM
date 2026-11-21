import { z } from 'zod';
import { ERROR_CODES } from './errors.js';

export const id = (prefix: string) => z.string().regex(new RegExp('^' + prefix + '_[0-7][0-9A-HJKMNP-TV-Z]{25}$'));
export const timestamp = z.number().nonnegative().refine(Number.isInteger).max(8_640_000_000_000_000);
export const numberKind = z.enum(['e164', 'short', 'unknown']);
export const callCause = z.enum(['remote_hangup','local_hangup','rejected','busy','no_answer','unreachable','network_error','local_answered','privacy_blocked','not_friend','timeout','cancelled','unknown']);
export const networkState = z.enum(['wifi','cellular','none','unknown']);
export const shizukuState = z.enum(['running','stopped','not_installed','unsupported','unknown']);
export const cellCallState = z.enum(['ringing','dialing','alerting','active','disconnected']);
export const sim = z.object({slot:z.number().nonnegative().refine(Number.isInteger), subId:z.number().refine(Number.isInteger).nullable(), carrier:z.string().nullable(), state:z.enum(['ready','absent','locked','unknown']), reportedNumber:z.string().nullable(), mcc:z.string().nullable(), mnc:z.string().nullable()});
const probe = z.object({result:z.enum(['ok','fail','untested','unsupported']),probedAt:timestamp,detail:z.string().nullable()});
export const probes = z.object({smsSend:probe,smsReceive:probe,dial:probe,answer:probe,hangup:probe,dtmf:probe,downlink:probe,uplink:probe,earlyMedia:probe});
export const permission = z.object({name:z.string(),granted:z.boolean()});
export const mediaLeg = z.object({sessionId:id('ses'),legId:id('leg'),path:z.string(),format:z.literal(2)});
export const ack = z.object({refId:z.string(),ok:z.boolean(),error:z.enum(ERROR_CODES).nullable()}).refine(({ok,error}) => ok === (error === null), {path:['error'],message:'error must be null exactly when ok is true'});
// A generation distinguishes separate incarnations of the same device-local callId.
export const callGeneration = id('gen');
const slot=z.number().nonnegative().refine(Number.isInteger); const subId=z.number().refine(Number.isInteger).nullable(); const callId=id('cal');
export const devicePayloads = {
 hello:z.object({token:z.string(),apkVersion:z.string(),apkCode:z.number().refine(Number.isInteger),protocol:z.literal(1),manufacturer:z.string(),model:z.string(),apiLevel:z.number().refine(Number.isInteger),locale:z.string(),capabilities:z.object({callGeneration:z.boolean().optional()}).optional()}),
 heartbeat:z.object({battery:z.number().min(0).max(100).nullable(),charging:z.boolean().nullable(),network:networkState,signalDbm:z.number().refine(Number.isInteger).nullable(),shizuku:shizukuState,paused:z.boolean()}),
 'status.snapshot':z.object({sims:z.array(sim),simsAuthoritative:z.boolean().optional(),capabilityLevel:z.enum(['L1','L2','L3','L4','L5']),probes,permissions:z.array(permission)}),
 'sms.received':z.object({subId,slot:slot.nullable(),from:z.string(),fromKind:numberKind,body:z.string(),receivedAt:timestamp,parts:z.number().positive().refine(Number.isInteger)}),
 'sms.result':z.object({taskId:id('tsk'),state:z.enum(['sent','failed','delivered','unknown']),errorCode:z.string().nullable().refine(value=>value!=='SMS_RESULT_CONFLICT',{message:'reserved Core error code'})}),
 'call.incoming':z.object({callId,generation:callGeneration.optional(),subId,slot:slot.nullable(),from:z.string().nullable(),fromKind:numberKind}),
 'call.state':z.object({callId,generation:callGeneration.optional(),state:cellCallState,cause:callCause.nullable()}),ack,
 'hello.ok':z.object({deviceId:id('dev'),serverTime:timestamp,config:z.object({heartbeatSec:z.number().positive().refine(Number.isInteger),locale:z.string()})}),
 'sms.send':z.object({taskId:id('tsk'),subId,slot,to:z.string(),body:z.string()}),
 'call.dial':z.object({callId,generation:callGeneration.optional(),subId,slot,to:z.string(),media:mediaLeg}),
 'call.answer':z.object({callId,generation:callGeneration.optional(),media:mediaLeg}),
 'call.reject':z.object({callId,generation:callGeneration.optional()}),'call.hangup':z.object({callId,generation:callGeneration.optional()}),
 'call.dtmf':z.object({callId,generation:callGeneration.optional(),digits:z.string().regex(/^[0-9*#]+$/)}),
 'probe.run':z.object({items:z.array(z.string())}),
 'config.update':z.object({heartbeatSec:z.number().positive().refine(Number.isInteger).optional(),locale:z.string().optional()}),
} as const;
export function parseDeviceMessage(value: unknown, direction: 'event' | 'command') {
 const envelope=z.object({v:z.literal(1),type:z.string(),id:id(direction === 'event' ? 'evt' : 'cmd'),ts:timestamp,payload:z.unknown()}).parse(value);
 const schema=devicePayloads[envelope.type as keyof typeof devicePayloads];
 if (!schema) throw new Error('unknown device message type');
 const events=['hello','heartbeat','status.snapshot','sms.received','sms.result','call.incoming','call.state','ack'];
 const commands=['hello.ok','sms.send','call.dial','call.answer','call.reject','call.hangup','call.dtmf','probe.run','config.update','ack'];
 if (!(direction === 'event' ? events : commands).includes(envelope.type)) throw new Error('wrong device message direction');
 return {...envelope,payload:schema.parse(envelope.payload)};
}
