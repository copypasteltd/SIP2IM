// JSON text encoded as UTF-16LE without a BOM preserves parsed string code units.
// Only the fixed-order SMS envelope supplies canonical bytes for comparison.
export const SMS_QUARANTINE_ENCODING = 'json-utf16le-v1';
export const MAX_SMS_QUARANTINE_BYTES = 262_144;
export class QuarantinePayloadTooLarge extends Error {}

function validateJson(value: unknown, ancestors = new Set<object>(), depth = 0,
    budget = {nodes: 0, units: 0, preserveNegativeZero: false}): void {
  if (depth > 32 || ++budget.nodes > 4096) throw new Error('JSON shape exceeds bounds');
  const addUnits = (units: number) => {
    budget.units += units;
    if (budget.units > MAX_SMS_QUARANTINE_BYTES / 2) throw new QuarantinePayloadTooLarge('JSON text exceeds bounds');
  };
  if (typeof value === 'string') { addUnits(value.length); return; }
  if (value === null || typeof value === 'boolean') return;
  if (typeof value === 'number' && Number.isFinite(value) && (budget.preserveNegativeZero || !Object.is(value, -0))) return;
  if (typeof value !== 'object') throw new Error('Expected plain JSON value');
  if (ancestors.has(value)) throw new Error('Cyclic JSON value');
  const array=Array.isArray(value);
  const proto=Object.getPrototypeOf(value);
  if (array ? proto!==Array.prototype : proto!==Object.prototype && proto!==null) throw new Error('Expected plain JSON value');
  if ('toJSON' in value) throw new Error('toJSON is not supported');
  ancestors.add(value);
  const keys=Reflect.ownKeys(value);
  if (array && keys.length !== (value as unknown[]).length+1) throw new Error('Sparse or decorated array');
  for (const key of keys) {
    if (array && key==='length') continue;
    if (typeof key !== 'string') throw new Error('Symbol keys are not JSON');
    if (array && (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key)>=(value as unknown[]).length)) throw new Error('Sparse or decorated array');
    const descriptor=Object.getOwnPropertyDescriptor(value,key)!;
    if (!descriptor.enumerable || !('value' in descriptor)) throw new Error('Expected enumerable data property');
    addUnits(key.length);
    validateJson(descriptor.value, ancestors, depth + 1, budget);
  }
  ancestors.delete(value);
}
export function encodeQuarantinePayload(payload: unknown): Buffer {
  validateJson(payload);
  const json = JSON.stringify(payload);
  if (json === undefined) throw new Error('Expected JSON text');
  return encodeQuarantineJson(json);
}

/** Encode JSON produced by a trusted serializer under the same byte bound. */
export function encodeQuarantineJson(json: string): Buffer {
  if (json.length > MAX_SMS_QUARANTINE_BYTES / 2) throw new QuarantinePayloadTooLarge('JSON text exceeds bounds');
  return Buffer.from(json, 'utf16le');
}
export function decodeQuarantinePayload(bytes: Buffer): unknown {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length > MAX_SMS_QUARANTINE_BYTES || bytes.length % 2 !== 0) {
    throw new Error('Invalid UTF-16LE byte length');
  }
  const value: unknown = JSON.parse(bytes.toString('utf16le'));
  validateJson(value, new Set<object>(), 0, {nodes:0, units:0, preserveNegativeZero:true});
  return value;
}
export function hasPostgresInvalidString(value: unknown): boolean {
  if (typeof value === 'string') {
    for (let i=0; i<value.length; i++) {
      const c=value.charCodeAt(i);
      if (c===0) return true;
      if (c>=0xd800 && c<=0xdbff) {
        const next=value.charCodeAt(++i);
        if (!(next>=0xdc00 && next<=0xdfff)) return true;
      } else if (c>=0xdc00 && c<=0xdfff) return true;
    }
    return false;
  }
  if (Array.isArray(value)) return value.some(hasPostgresInvalidString);
  if (value && typeof value === 'object') return Object.entries(value).some(([k,v])=>hasPostgresInvalidString(k)||hasPostgresInvalidString(v));
  return false;
}
