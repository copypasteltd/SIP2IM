import {encodeQuarantinePayload, encodeQuarantineJson, hasPostgresInvalidString, MAX_SMS_QUARANTINE_BYTES, QuarantinePayloadTooLarge} from './sms-quarantine-codec.js';

const eventFields = ['v', 'type', 'id', 'ts', 'payload'] as const;
const payloadFields = ['subId', 'slot', 'from', 'fromKind', 'body', 'receivedAt', 'parts'] as const;
const eventIdPattern = /^evt_[0-7][0-9A-HJKMNP-TV-Z]{25}$/;

export function isSmsEventId(value: unknown): value is string {
  return typeof value === 'string' && value.length === 30 && eventIdPattern.test(value);
}

function exactDataFields(value: unknown, fields: readonly string[]): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype ||
      Reflect.ownKeys(value).length !== fields.length) return false;
  return fields.every(field => {
    const property = Object.getOwnPropertyDescriptor(value, field);
    return property?.enumerable === true && 'value' in property;
  });
}

const integer = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value);
const timestamp = (value: unknown): value is number => integer(value) && value >= 0 && value <= 8_640_000_000_000_000;

/** Protocol-parsed v1 event, not original JSON wire bytes or Android PDU data. */
export type ParsedSmsEnvelope = {
 v: 1; type: 'sms.received'; id: string; ts: number;
 payload: {subId:number|null; slot:number|null; from:string; fromKind:'e164'|'short'|'unknown'; body:string; receivedAt:number; parts:number};
};
export type SmsQuarantineReason = 'postgres-invalid-string' | 'parts-out-of-range' | 'postgres-index-limit';

/** Validate the complete v1 parsed shape without reparsing and stripping fields. */
export function isParsedSmsEnvelope(input: unknown): input is ParsedSmsEnvelope {
  if (!exactDataFields(input, eventFields) || !exactDataFields(input.payload, payloadFields)) return false;
  const p = input.payload;
  return input.v === 1 && input.type === 'sms.received' && isSmsEventId(input.id) && timestamp(input.ts) &&
    (p.subId === null || integer(p.subId)) && (p.slot === null || (integer(p.slot) && p.slot >= 0)) &&
    typeof p.from === 'string' && (p.fromKind === 'e164' || p.fromKind === 'short' || p.fromKind === 'unknown') &&
    typeof p.body === 'string' && timestamp(p.receivedAt) && integer(p.parts) && p.parts > 0;
}

export function isSmsQuarantineReason(value: unknown): value is string {
  return value === 'postgres-invalid-string' || value === 'parts-out-of-range' ||
    value === 'postgres-invalid-string,parts-out-of-range' || value === 'postgres-index-limit';
}

/**
 * Input must be an immutable event produced by parseDeviceMessage. Fix field order
 * explicitly: JSON object order on the wire is not identity. JSON.stringify
 * normalizes -0 to 0, matching PostgreSQL JSONB numeric equality; numeric values
 * are the already-parsed JavaScript numbers, not the original JSON number tokens.
 * Device identity is deliberately separate and must also be compared atomically.
 */
export function canonicalSmsEnvelope(event: ParsedSmsEnvelope): Buffer {
 const p=event.payload;
 const number=(n:number)=>Object.is(n,-0)?0:n;
 return encodeQuarantinePayload({v:event.v,type:event.type,id:event.id,ts:number(event.ts),payload:{
  subId:p.subId===null?null:number(p.subId), slot:p.slot===null?null:number(p.slot),
  from:p.from,fromKind:p.fromKind,body:p.body,receivedAt:number(p.receivedAt),parts:number(p.parts),
 }});
}

/** Store all parsed values, including the sign of negative zero in the original sample. */
export function encodeSmsCustodyEnvelope(event: ParsedSmsEnvelope): Buffer {
  if (!isParsedSmsEnvelope(event)) throw new Error('Expected a parsed SMS envelope');
  const p = event.payload;
  if (p.from.length + p.body.length > MAX_SMS_QUARANTINE_BYTES / 2) throw new QuarantinePayloadTooLarge('JSON text exceeds bounds');
  // Only serialize the fixed scalar fields. JSON.stringify quotes every string and key.
  const jsonValue = (value: unknown) => Object.is(value,-0) ? '-0' : JSON.stringify(value);
  const field = (key: string, value: unknown) => JSON.stringify(key) + ':' + jsonValue(value);
  const payload = payloadFields.map(key=>field(key,p[key])).join(',');
  const envelope = eventFields.filter(key=>key!=='payload').map(key=>field(key,event[key])).join(',');
  return encodeQuarantineJson('{' + envelope + ',"payload":{' + payload + '}}');
}

/** The normal projection writes parts as PostgreSQL int4 and strings as jsonb/text. */
export function smsQuarantineReasons(event: ParsedSmsEnvelope): SmsQuarantineReason[] {
 const reasons:SmsQuarantineReason[]=[];
 if(hasPostgresInvalidString(event.payload.from) || hasPostgresInvalidString(event.payload.body)) reasons.push('postgres-invalid-string');
 if(event.payload.parts>2_147_483_647) reasons.push('parts-out-of-range');
 return reasons;
}
