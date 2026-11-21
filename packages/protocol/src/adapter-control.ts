import { z } from 'zod';
import { ack, callCause, id, timestamp } from './device.js';
export const platform = z.enum(['qq','telegram']);
export const accountState = z.enum(['logged_out','login_pending','logged_in','offline','banned','error']);
export const loginStep = z.enum(['qr','phone','code','password']);
export const capabilities = z.object({login:z.boolean(),sendMessage:z.boolean(),receiveMessage:z.boolean(),dial:z.boolean(),receiveAudio:z.boolean(),sendAudio:z.boolean(),maxConcurrentCalls:z.number().nonnegative().refine(Number.isInteger)});
/** Experimental identity; adapter must verify its account against the active session before use. */
const identityPart = z.string().min(1).max(256).refine(s => s.trim() === s && !/[\u0000-\u001f\u007f]/.test(s) && s !== '0', 'invalid identity component');
export const platformMessageIdentity = z.object({
 version:z.literal(1), accountId:identityPart,
 peer:z.object({type:z.enum(['user','group','channel']),id:identityPart}).strict(),
 namespace:z.literal('server'), messageId:identityPart,
}).strict();
export type PlatformMessageIdentity = z.infer<typeof platformMessageIdentity>;
export const adapterPayloads = {
 'adapter.hello':z.object({platform,adapterVersion:z.string(),protocol:z.literal(1)}),
 capabilities,
 'account.state':z.object({state:accountState,selfId:z.string().nullable(),alias:z.string().nullable(),detail:z.string().nullable()}),
 'login.step':z.object({step:loginStep,qrPngBase64:z.string().nullable(),hint:z.string().nullable()}),
 'message.received':z.object({identity:platformMessageIdentity.optional(),platformMessageId:z.string(),senderId:z.string(),senderName:z.string().nullable(),chatType:z.enum(['private','group','channel']),forwarded:z.boolean(),isContact:z.boolean().nullable(),text:z.string(),ts:timestamp}),
 'call.state':z.object({callId:id('cal'),state:z.enum(['dialing','ringing','connected','ended','failed']),cause:callCause.nullable()}),
 'call.incoming.rejected':z.object({fromUserId:z.string(),ts:timestamp}),
 'account.login':z.object({}), 'account.login.submit':z.object({step:loginStep,value:z.string()}),
 'account.logout':z.object({}), 'message.send':z.object({userId:z.string(),text:z.string()}),
 'call.dial':z.object({callId:id('cal'),userId:z.string(),audioChannel:z.number().min(0).max(255).refine(Number.isInteger)}),
 'call.hangup':z.object({callId:id('cal')}),ack,
} as const;
export function parseAdapterMessage(value:unknown) {
 const envelope=z.object({v:z.literal(1),type:z.string(),id:id('ipc'),ts:timestamp,payload:z.unknown()}).parse(value);
 const schema=adapterPayloads[envelope.type as keyof typeof adapterPayloads];
 if (!schema) throw new Error('unknown adapter message type');
 return {...envelope,payload:schema.parse(envelope.payload)};
}
export function decodeAdapterJson(bytes:Uint8Array) {
 return parseAdapterMessage(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)) as unknown);
}
export function encodeAdapterJson(value:unknown):Uint8Array {
 return new TextEncoder().encode(JSON.stringify(parseAdapterMessage(value)));
}
