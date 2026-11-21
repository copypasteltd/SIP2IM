export type SmsPermissionState = 'granted' | 'missing' | 'unknown';

interface SmsPermissionObservation {
  value: unknown;
  observedAt: Date;
  receivedAt: Date;
  ttlSec: number;
}

type SmsPermission = 'SEND_SMS' | 'RECEIVE_SMS';
const MAX_AGE_SEC = 24 * 60 * 60;

function permissionValue(entries: readonly unknown[], name: SmsPermission): boolean | undefined {
  const qualified = 'android.permission.' + name;
  let value: boolean | undefined;
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object' || !('name' in entry) ||
      (entry.name !== name && entry.name !== qualified)) continue;
    const granted = 'granted' in entry ? entry.granted : undefined;
    if (typeof granted !== 'boolean' || (value !== undefined && value !== granted)) return undefined;
    value = granted;
  }
  return value;
}

/** Only fresh, unambiguous evidence can grant or deny a required permission. */
export function assessSmsPermissions(observation: SmsPermissionObservation | undefined, now: number): SmsPermissionState {
  if (!observation || !Number.isFinite(now)) return 'unknown';
  const { value, observedAt, receivedAt, ttlSec } = observation;
  if (!(observedAt instanceof Date) || !(receivedAt instanceof Date) ||
    !Number.isSafeInteger(ttlSec) || ttlSec <= 0 || !Array.isArray(value)) return 'unknown';
  const observed = observedAt.getTime();
  const received = receivedAt.getTime();
  if (!Number.isFinite(observed) || !Number.isFinite(received) || observed < 0 ||
    observed > received || received > now || now - observed > Math.min(ttlSec, MAX_AGE_SEC) * 1000) return 'unknown';

  const send = permissionValue(value, 'SEND_SMS');
  const receive = permissionValue(value, 'RECEIVE_SMS');
  if (send === false || receive === false) return 'missing';
  return send === true && receive === true ? 'granted' : 'unknown';
}
