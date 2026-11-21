/** Isolated comparison of protocol-parsed v1 SMS events; not connected to ingestion. */
type RecordValue = Record<string, unknown>;
export type SmsComparison = 'equal' | 'different' | 'invalid';

const eventKeys = ['deviceId', 'v', 'type', 'id', 'ts', 'payload'] as const;
const payloadKeys = ['subId', 'slot', 'from', 'fromKind', 'body', 'receivedAt', 'parts'] as const;
const maxTimestamp = 8_640_000_000_000_000;
const eventId = /^evt_[0-7][0-9A-HJKMNP-TV-Z]{25}$/;
const deviceId = /^dev_[0-7][0-9A-HJKMNP-TV-Z]{25}$/;

// Only data objects produced by parsing are in scope, not accessors or exotic objects.
function hasFields(value: unknown, fields: readonly string[]): value is RecordValue {
  if (typeof value !== 'object' || value === null || Object.getPrototypeOf(value) !== Object.prototype) return false;
  const keys = Reflect.ownKeys(value);
  return keys.length === fields.length && fields.every(key => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor?.enumerable === true && 'value' in descriptor;
  });
}
const integer = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value);
const timestamp = (value: unknown): value is number => integer(value) && value >= 0 && value <= maxTimestamp;

function valid(value: unknown): value is RecordValue & {payload: RecordValue} {
  if (!hasFields(value, eventKeys) || !hasFields(value.payload, payloadKeys)) return false;
  const p = value.payload;
  return value.v === 1 && value.type === 'sms.received' &&
    typeof value.id === 'string' && eventId.test(value.id) &&
    typeof value.deviceId === 'string' && deviceId.test(value.deviceId) && timestamp(value.ts) &&
    (p.subId === null || integer(p.subId)) &&
    (p.slot === null || (integer(p.slot) && p.slot >= 0)) &&
    typeof p.from === 'string' && (p.fromKind === 'e164' || p.fromKind === 'short' || p.fromKind === 'unknown') &&
    typeof p.body === 'string' && timestamp(p.receivedAt) && integer(p.parts) && p.parts > 0;
}

/**
 * Compare parsed values, including identity metadata. JavaScript string equality compares
 * UTF-16 code units, including NUL and lone surrogates; numeric === makes -0 equal 0.
 * Both sides are validated before comparing, so invalid values never become duplicates.
 * The supported numeric domain is deliberately narrower than the protocol's Zod schema.
 */
export function compareParsedSmsReceived(left: unknown, right: unknown): SmsComparison {
  try {
    if (!valid(left) || !valid(right)) return 'invalid';
    return eventKeys.every(key => key === 'payload' || left[key] === right[key]) &&
      payloadKeys.every(key => left.payload[key] === right.payload[key]) ? 'equal' : 'different';
  } catch {
    // Throwing proxy traps cannot be treated as an equal event.
    return 'invalid';
  }
}
