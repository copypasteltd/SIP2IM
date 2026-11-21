import { ApiError, request } from '../../api/client';

const codes = '/api/devices/binding-codes';
const recordIdPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const isRecordId = (value: unknown): value is string => typeof value === 'string' && value.length === 36 && recordIdPattern.test(value);
const isTime = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 8.64e15;
const isDeviceId = (value: unknown): value is string => typeof value === 'string' && /^dev_[0-7][0-9A-HJKMNP-TV-Z]{25}$/.test(value) && value.length === 30;
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const invalidResponse = () => new ApiError('INVALID_RESPONSE', 200);

export type IssuedCode = { recordId: string; code: string; expiresAt: number; qrPayload: string };
export type BindingRecord = {
  recordId: string;
  createdAt: number;
  expiresAt: number;
  usedAt: number | null;
  deviceId: string | null;
  cancelledAt: number | null;
  protocolVersion: 1 | 2 | null;
  teardownPending: boolean;
};
export type BindingPage = { records: BindingRecord[]; nextCursor: string | null };
export type Cancellation = { recordId: string; deviceId: string | null };

function checkedQr(payload: string, code: string) {
  try {
    const url = new URL(payload);
    const host = url.searchParams.get('host');
    const port = url.searchParams.get('port');
    return url.protocol === 'voipgw:' && url.host === 'bind' && !url.pathname && !url.hash && !url.username && !url.password
      && url.searchParams.size === 3 && !!host?.trim() && !!port && /^[1-9]\d{0,4}$/.test(port) && Number(port) <= 65535
      && url.searchParams.get('code') === code;
  } catch { return false; }
}

export async function issueBindingCode(signal: AbortSignal): Promise<IssuedCode> {
  const { data } = await request<unknown>(codes + '/v2', { method: 'POST', signal, cache: 'no-store' });
  if (!object(data) || !isRecordId(data.recordId) || !isTime(data.expiresAt) || typeof data.code !== 'string' ||
      data.code.length !== 6 || !/^[0-9]{6}$/.test(data.code) || typeof data.qrPayload !== 'string' || !checkedQr(data.qrPayload, data.code)) {
    throw invalidResponse();
  }
  const { recordId, code, expiresAt, qrPayload } = data;
  return { recordId, code, expiresAt, qrPayload };
}

function bindingRecord(value: unknown): BindingRecord {
  if (!object(value)) throw invalidResponse();
  const { recordId, createdAt, expiresAt, usedAt, deviceId, cancelledAt, protocolVersion, teardownPending } = value;
  if (!isRecordId(recordId) || !isTime(createdAt) || !isTime(expiresAt) || (usedAt !== null && !isTime(usedAt)) ||
      (deviceId !== null && !isDeviceId(deviceId)) || (cancelledAt !== null && !isTime(cancelledAt)) ||
      (protocolVersion !== null && protocolVersion !== 1 && protocolVersion !== 2) || typeof teardownPending !== 'boolean' ||
      (teardownPending && (cancelledAt === null || deviceId === null))) throw invalidResponse();
  return { recordId, createdAt, expiresAt, usedAt, deviceId, cancelledAt, protocolVersion, teardownPending };
}

export async function readBindingRecords(cursor: string | null, signal: AbortSignal): Promise<BindingPage> {
  if (cursor !== null && !isRecordId(cursor)) throw invalidResponse();
  const query = cursor === null ? '' : '?' + new URLSearchParams({ cursor });
  const { data, nextCursor } = await request<unknown>(codes + query, { signal, cache: 'no-store' });
  if (!Array.isArray(data) || (nextCursor !== null && !isRecordId(nextCursor))) throw invalidResponse();
  const records = data.map(bindingRecord);
  if (records.some((row, index) => index === 0 ? cursor !== null && row.recordId <= cursor : row.recordId <= records[index - 1].recordId) ||
      (nextCursor !== null && nextCursor !== records.at(-1)?.recordId)) throw invalidResponse();
  return { records, nextCursor };
}

export async function cancelBindingRecord(record: BindingRecord, signal: AbortSignal): Promise<Cancellation> {
  if (!isRecordId(record.recordId)) throw invalidResponse();
  const { data } = await request<unknown>(codes + '/' + encodeURIComponent(record.recordId) + '/cancel', {
    method: 'POST', signal, cache: 'no-store',
  });
  if (!object(data) || data.recordId !== record.recordId || (data.deviceId !== null && !isDeviceId(data.deviceId)) ||
      (record.deviceId !== null && data.deviceId !== record.deviceId)) throw invalidResponse();
  return { recordId: record.recordId, deviceId: data.deviceId };
}
