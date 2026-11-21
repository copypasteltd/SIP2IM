import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { SmsQuarantineInventory } from './quarantine-inventory';
import { useSession } from '../../stores/session';
import i18n from '../../i18n';

const id = '00000000-0000-4000-8000-000000000001';
const event = { v: 1, type: 'sms.received', id: 'evt_01ARZ3NDEKTSV4RRFFQ69G5FAW', ts: 120, payload: { subId: null, slot: 0, from: 'fixture', fromKind: 'unknown', body: 'fixture\u0000body', receivedAt: 120, parts: 1 } };
const base64 = (value: object) => btoa(Array.from(JSON.stringify(value), unit => unit + '\x00').join(''));
const payloadBase64 = base64(event);
const row = { id, createdAt: '2026-11-20 08:17:27.000000+00', deviceId: 'dev_01ARZ3NDEKTSV4RRFFQ69G5FAV', eventId: event.id, reason: 'postgres-invalid-string', encoding: 'json-utf16le-v1', payloadLength: atob(payloadBase64).length, deviceTs: event.ts, state: 'retained' };
const result = (data: unknown) => new Response(JSON.stringify({ data, nextCursor: null }));
beforeEach(async () => { await i18n.changeLanguage('en'); useSession.getState().setSession({ token: 'fixture-admin', expiresAt: Date.now() + 100_000, username: 'fixture' }); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); useSession.getState().setSession(null); });

it.each([
  { id: '00000000-0000-4000-8000-000000000002' }, { payloadLength: 6 }, { deviceId: 'different-device' },
  { payloadBase64: 'AAAAAA==' }, { payloadBase64: 'ewB9AB==' }, { state: 'needs_attention' },
  { payloadBase64: base64({ ...event, id: 'evt_01ARZ3NDEKTSV4RRFFQ69G5FAX' }) },
  { payloadBase64: base64({ ...event, ts: 121 }) },
])('rejects mismatched or invalid export data %j', async change => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(result([row])).mockResolvedValueOnce(result([{ ...row, payloadBase64, ...change }])));
  const createObjectURL = vi.fn();
  vi.stubGlobal('URL', class extends URL { static createObjectURL = createObjectURL; });
  render(<SmsQuarantineInventory/>);
  fireEvent.click(screen.getByRole('button', { name: 'Load inventory' }));
  await screen.findByRole('heading', { name: id });
  fireEvent.click(screen.getByRole('button', { name: 'Export record' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('export is unavailable');
  expect(createObjectURL).not.toHaveBeenCalled();
});

it('rejects inventory pages that contain sensitive export bytes', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(result([{ ...row, payloadBase64 }])));
  render(<SmsQuarantineInventory/>);
  fireEvent.click(screen.getByRole('button', { name: 'Load inventory' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Could not load the quarantine inventory');
  expect(screen.queryByRole('button', { name: 'Export record' })).toBeNull();
});
