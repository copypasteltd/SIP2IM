import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { SmsQuarantineInventory } from './quarantine-inventory';
import { SmsPage } from './sms';
import { useSession } from '../../stores/session';
import i18n from '../../i18n';

const id = '00000000-0000-4000-8000-000000000001';
const event = { v: 1, type: 'sms.received', id: 'evt_01ARZ3NDEKTSV4RRFFQ69G5FAW', ts: 1_000, payload: { subId: null, slot: 0, from: 'fixture', fromKind: 'unknown', body: 'fixture\u0000body', receivedAt: 1_000, parts: 1 } };
const bytes = JSON.stringify(event);
const payloadBase64 = btoa(Array.from(bytes, unit => unit + '\x00').join(''));
const row = { id, createdAt: '2026-11-20 08:17:27.000000+00', deviceId: 'dev_01ARZ3NDEKTSV4RRFFQ69G5FAV', eventId: event.id, reason: 'postgres-invalid-string', encoding: 'json-utf16le-v1', payloadLength: bytes.length * 2, deviceTs: event.ts, state: 'retained' };
const result = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
const inventory = () => result({ data: [row], nextCursor: null });
const exported = () => result({ data: [{ ...row, payloadBase64 }], nextCursor: null });
const session = (token = 'fixture-admin-token') => ({ token, expiresAt: Date.now() + 100_000, username: 'fixture' });

beforeEach(async () => { await i18n.changeLanguage('en'); useSession.getState().setSession(session()); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); useSession.getState().setSession(null); });

function downloadFixture() {
  const createObjectURL = vi.fn(() => 'blob:fixture');
  const revokeObjectURL = vi.fn();
  const url = class extends URL { static createObjectURL = createObjectURL; static revokeObjectURL = revokeObjectURL; };
  vi.stubGlobal('URL', url);
  const download = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  return { createObjectURL, revokeObjectURL, download };
}

it('requests authenticated no-store inventory, then exports the selected record only after a click', async () => {
  const fetcher = vi.fn(async (url: string, options?: RequestInit) => {
    expect(options?.cache).toBe('no-store');
    expect(new Headers(options?.headers).get('Authorization')).toBe('Bearer fixture-admin-token');
    return url.endsWith('/export') ? exported() : inventory();
  });
  const { createObjectURL, revokeObjectURL, download } = downloadFixture();
  vi.stubGlobal('fetch', fetcher);
  const view = render(<SmsQuarantineInventory/>);
  expect(fetcher).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Load inventory' }));
  await screen.findByRole('heading', { name: id });
  expect(fetcher.mock.calls.map(call => call[0])).toEqual(['/api/admin/sms-quarantine?limit=25']);
  expect(screen.queryByText(payloadBase64)).toBeNull();
  expect(download).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Export record' }));
  await waitFor(() => expect(download).toHaveBeenCalledOnce());
  expect(fetcher.mock.calls[1][0]).toBe('/api/admin/sms-quarantine/' + id + '/export');
  expect(createObjectURL).toHaveBeenCalledWith(expect.any(Blob));
  view.unmount();
  expect(revokeObjectURL).toHaveBeenCalledWith('blob:fixture');
});

it.each([403, 404, 503])('shows an unavailable inventory and no export control on HTTP %s', async status => {
  vi.stubGlobal('fetch', vi.fn(async () => result({ error: { code: 'QUARANTINE_UNAVAILABLE' } }, status)));
  render(<SmsQuarantineInventory/>);
  fireEvent.click(screen.getByRole('button', { name: 'Load inventory' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('unavailable');
  expect(screen.queryByRole('button', { name: 'Export record' })).toBeNull();
});

it('keeps sensitive inventory reads behind the operator panel and explicit load action', async () => {
  const fetcher = vi.fn(async (url: string) => url.includes('/sms-quarantine?') ? inventory() : result({ data: [], nextCursor: null }));
  vi.stubGlobal('fetch', fetcher);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><MemoryRouter><SmsPage/></MemoryRouter></QueryClientProvider>);
  expect(fetcher.mock.calls.some(call => call[0].includes('/sms-quarantine'))).toBe(false);
  fireEvent.click(await screen.findByRole('button', { name: 'SMS quarantine inventory' }));
  const panel = await screen.findByRole('heading', { name: 'SMS quarantine inventory' });
  expect(fetcher.mock.calls.some(call => call[0].includes('/sms-quarantine'))).toBe(false);
  fireEvent.click(within(panel.closest('section')!).getByRole('button', { name: 'Load inventory' }));
  await screen.findByRole('heading', { name: id });
  expect(fetcher.mock.calls.filter(call => call[0].includes('/sms-quarantine')).map(call => call[0])).toEqual(['/api/admin/sms-quarantine?limit=25']);
});

it('cancels a pending export and discards a late payload when the session changes', async () => {
  let reply!: (value: Response) => void;
  const fetcher = vi.fn((...args: [string, RequestInit?]) => args[0].endsWith('/export') ? new Promise<Response>(resolve => { reply = resolve; }) : Promise.resolve(inventory()));
  const { createObjectURL } = downloadFixture();
  vi.stubGlobal('fetch', fetcher);
  render(<SmsQuarantineInventory/>);
  fireEvent.click(screen.getByRole('button', { name: 'Load inventory' }));
  await screen.findByRole('heading', { name: id });
  fireEvent.click(screen.getByRole('button', { name: 'Export record' }));
  await waitFor(() => expect(reply).toBeDefined());
  act(() => useSession.getState().setSession(session('replacement-admin')));
  expect(fetcher.mock.calls[1][1]?.signal?.aborted).toBe(true);
  await act(async () => { reply(exported()); });
  expect(createObjectURL).not.toHaveBeenCalled();
  expect(screen.queryByRole('heading', { name: id })).toBeNull();
});
