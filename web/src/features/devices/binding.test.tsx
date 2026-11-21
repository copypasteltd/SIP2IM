import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import i18n from '../../i18n';
import { useSession } from '../../stores/session';
import { BindDevice } from './binding';

vi.mock('../../components/ui/qr-code', () => ({
  QrCode: ({ value }: { value: string }) => <img alt="Device binding QR code" data-payload={value}/>,
}));

const codes = '/api/devices/binding-codes';
const firstId = '00000000-0000-4000-8000-000000000001';
const secondId = '00000000-0000-4000-8000-000000000002';
const deviceId = 'dev_00000000000000000000000001';
const admin = { token: 'synthetic-admin', username: 'admin' };
const response = (data: unknown) => new Response(JSON.stringify({ data }));
const errorResponse = (status: number, code: string) => new Response(JSON.stringify({ error: { code } }), { status });
const record = (recordId: string) => ({ recordId, createdAt: Date.now() - 1000, expiresAt: Date.now() + 10_000,
  usedAt: null, deviceId: null, cancelledAt: null, protocolVersion: null, teardownPending: false });
const page = (data: unknown[], nextCursor: string | null = null) => new Response(JSON.stringify({ data, nextCursor }));
const issued = () => {
  const code = String(43).padStart(6, '0');
  const qrPayload = 'voipgw://bind?' + new URLSearchParams({ host: 'example.test', port: '47860', code });
  return { ...record(firstId), code, qrPayload };
};

const dialogPrototype = HTMLDialogElement.prototype;
const nativeShow = Object.getOwnPropertyDescriptor(dialogPrototype, 'showModal');
const nativeClose = Object.getOwnPropertyDescriptor(dialogPrototype, 'close');

beforeEach(async () => {
  await i18n.changeLanguage('en');
  useSession.getState().setSession({ ...admin, expiresAt: Date.now() + 600_000 });
  // JSDOM does not implement native modal dialogs.
  Object.defineProperty(dialogPrototype, 'showModal', { configurable: true, value(this: HTMLDialogElement) { this.open = true; } });
  Object.defineProperty(dialogPrototype, 'close', { configurable: true, value(this: HTMLDialogElement) {
    this.open = false;
    this.dispatchEvent(new Event('close'));
  } });
});

afterEach(() => {
  cleanup();
  useSession.getState().setSession(null);
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  for (const [name, descriptor] of [['showModal', nativeShow], ['close', nativeClose]] as const) {
    if (descriptor) Object.defineProperty(dialogPrototype, name, descriptor);
    else Reflect.deleteProperty(dialogPrototype, name);
  }
});

function setup(fetchMock: ReturnType<typeof vi.fn>) {
  vi.stubGlobal('fetch', fetchMock);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><BindDevice/></QueryClientProvider>);
  return client;
}

function openDialog(name: string) {
  fireEvent.click(screen.getByRole('button', { name }));
  return within(screen.getByRole('dialog', { name }));
}

function noStoreCall(url: string, method: string) {
  return [url, expect.objectContaining({ method, cache: 'no-store', redirect: 'error', body: undefined,
    headers: new Headers({ Authorization: 'Bearer ' + admin.token }) })];
}

async function selectForReview(dialog: ReturnType<typeof within>, recordId: string) {
  fireEvent.click(await dialog.findByRole('radio', { name: recordId }));
  fireEvent.click(dialog.getByRole('button', { name: 'Review cancellation' }));
  return dialog.getByRole('button', { name: 'Confirm cancellation' });
}

it('issues once via v2 and removes the plaintext and QR at expiry while retaining the record ID', async () => {
  const data = issued();
  const fetchMock = vi.fn().mockResolvedValueOnce(response(data));
  setup(fetchMock);
  vi.useFakeTimers();
  const dialog = openDialog('Bind new device');
  await act(async () => {});
  expect(fetchMock.mock.calls).toEqual([noStoreCall(codes + '/v2', 'POST')]);
  expect(dialog.getByText(data.code)).toBeInTheDocument();
  expect(dialog.getByText(data.recordId)).toBeInTheDocument();
  expect(dialog.getByRole('img', { name: 'Device binding QR code' })).toHaveAttribute('data-payload', data.qrPayload);
  act(() => { vi.advanceTimersByTime(10_001); });
  expect(dialog.queryByText(data.code)).not.toBeInTheDocument();
  expect(dialog.queryByRole('img')).not.toBeInTheDocument();
  expect(dialog.getByRole('status')).toHaveTextContent('Expired');
  expect(dialog.getByText(data.recordId)).toBeInTheDocument();
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

it.each([404, 500, 200])('keeps v2 issuance uncertainty visible without fallback (HTTP %i)', async status => {
  const data = issued();
  const fetchMock = vi.fn().mockResolvedValueOnce(status === 200 ? response({ ...data, recordId: undefined }) : errorResponse(status, 'NOT_FOUND'));
  setup(fetchMock);
  const dialog = openDialog('Bind new device');
  expect(await dialog.findByRole('alert')).toHaveTextContent(status === 404 ? 'does not offer v2' : 'could not be confirmed');
  expect(dialog.queryByText(data.code)).not.toBeInTheDocument();
  expect(dialog.queryByRole('img')).not.toBeInTheDocument();
  expect(fetchMock.mock.calls).toEqual([noStoreCall(codes + '/v2', 'POST')]);
});

it('discards an in-flight issuance when the administrator changes', async () => {
  let finish!: (result: Response) => void;
  const fetchMock = vi.fn().mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  setup(fetchMock);
  openDialog('Bind new device');
  const signal = fetchMock.mock.calls[0][1].signal as AbortSignal;
  act(() => { useSession.getState().setSession({ token: 'synthetic-replacement', username: 'replacement', expiresAt: Date.now() + 600_000 }); });
  const data = issued();
  await act(async () => { finish(response(data)); });
  expect(signal.aborted).toBe(true);
  expect(screen.queryByText(data.code)).not.toBeInTheDocument();
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

it('pages metadata only and writes to the explicitly selected record after confirmation', async () => {
  const data = issued();
  const used = { ...record(secondId), deviceId, usedAt: Date.now(), protocolVersion: 2 };
  const fetchMock = vi.fn().mockResolvedValueOnce(page([data], firstId)).mockResolvedValueOnce(page([used]))
    .mockResolvedValueOnce(response({ recordId: secondId, deviceId }));
  const client = setup(fetchMock);
  const invalidate = vi.spyOn(client, 'invalidateQueries');
  const dialog = openDialog('Binding records');
  await dialog.findByRole('radio', { name: firstId });
  expect(dialog.queryByText(data.code)).not.toBeInTheDocument();
  expect(dialog.getByRole('button', { name: 'Review cancellation' })).toBeDisabled();
  fireEvent.click(dialog.getByRole('button', { name: 'Load more' }));
  const confirm = await selectForReview(dialog, secondId);
  expect(dialog.getByText(secondId)).toBeInTheDocument();
  expect(dialog.getByText(deviceId)).toBeInTheDocument();
  expect(dialog.getByText(/revokes any device linked/)).toBeInTheDocument();
  expect(fetchMock.mock.calls).toEqual([noStoreCall(codes, 'GET'), noStoreCall(codes + '?cursor=' + firstId, 'GET')]);
  fireEvent.click(dialog.getByRole('button', { name: 'Back to records' }));
  expect(fetchMock).toHaveBeenCalledTimes(2);
  fireEvent.click(dialog.getByRole('button', { name: 'Review cancellation' }));
  const confirmAgain = dialog.getByRole('button', { name: 'Confirm cancellation' });
  expect(confirm.isConnected).toBe(false);
  fireEvent.click(confirmAgain);
  fireEvent.click(confirmAgain);
  expect(await dialog.findByText(new RegExp('Cancellation confirmed for ' + secondId))).toHaveTextContent(deviceId);
  expect(fetchMock.mock.calls).toEqual([noStoreCall(codes, 'GET'), noStoreCall(codes + '?cursor=' + firstId, 'GET'),
    noStoreCall(codes + '/' + secondId + '/cancel', 'POST')]);
  expect(invalidate).toHaveBeenCalledWith({ queryKey: ['devices'] });
});

it('preserves unknown cancellation until the same recorded fence and finished teardown are read', async () => {
  const used = { ...record(firstId), deviceId, usedAt: Date.now(), protocolVersion: 1 };
  const pending = { ...used, cancelledAt: Date.now(), teardownPending: true };
  const fetchMock = vi.fn().mockResolvedValueOnce(page([used])).mockResolvedValueOnce(errorResponse(500, 'INTERNAL'))
    .mockResolvedValueOnce(page([])).mockResolvedValueOnce(page([pending])).mockResolvedValueOnce(page([{ ...pending, teardownPending: false }]));
  setup(fetchMock);
  const dialog = openDialog('Binding records');
  fireEvent.click(await selectForReview(dialog, firstId));
  expect(await dialog.findByRole('alert')).toHaveTextContent('is unconfirmed');
  expect(dialog.queryByRole('button', { name: 'Confirm cancellation' })).not.toBeInTheDocument();
  fireEvent.click(dialog.getByRole('button', { name: 'Refresh binding records' }));
  expect(await dialog.findByText('No binding records returned.')).toBeInTheDocument();
  expect(dialog.getByRole('alert')).toHaveTextContent(firstId);
  fireEvent.click(dialog.getByRole('button', { name: 'Refresh binding records' }));
  expect(await dialog.findByText(/device cleanup pending/)).toBeInTheDocument();
  expect(dialog.getByRole('alert')).toHaveTextContent(firstId);
  expect(dialog.getByRole('button', { name: 'Review cancellation' })).toBeDisabled();
  fireEvent.click(dialog.getByRole('button', { name: 'Refresh binding records' }));
  expect(await dialog.findByText(/Cancellation confirmed/)).toHaveTextContent(deviceId);
  expect(dialog.getByRole('radio', { name: firstId })).toBeDisabled();
  expect(fetchMock.mock.calls.map(([, init]) => init.method)).toEqual(['GET', 'POST', 'GET', 'GET', 'GET']);
});

it('treats a response for a different record as unknown and does not loop on bad inventory cursors', async () => {
  const fetchMock = vi.fn().mockResolvedValueOnce(page([record(firstId)])).mockResolvedValueOnce(response({ recordId: secondId, deviceId: null }))
    .mockResolvedValueOnce(page([record(firstId)], secondId));
  setup(fetchMock);
  const dialog = openDialog('Binding records');
  fireEvent.click(await selectForReview(dialog, firstId));
  expect(await dialog.findByRole('alert')).toHaveTextContent(firstId);
  fireEvent.click(dialog.getByRole('button', { name: 'Refresh binding records' }));
  expect(await dialog.findByText(/Could not read binding records/)).toBeInTheDocument();
  expect(dialog.queryByRole('radio')).not.toBeInTheDocument();
  expect(dialog.queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument();
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
});

it('keeps separate unknown cancellations and blocks a refreshed row whose linked device changed', async () => {
  const used = { ...record(firstId), deviceId, usedAt: Date.now(), protocolVersion: 2 };
  const second = record(secondId);
  const changed = { ...used, deviceId: 'dev_00000000000000000000000002', cancelledAt: Date.now() };
  const fetchMock = vi.fn().mockResolvedValueOnce(page([used, second])).mockResolvedValueOnce(errorResponse(404, 'NOT_FOUND'))
    .mockResolvedValueOnce(page([changed, second])).mockRejectedValueOnce(new Error('Offline'));
  setup(fetchMock);
  const dialog = openDialog('Binding records');
  fireEvent.click(await selectForReview(dialog, firstId));
  expect(await dialog.findByRole('alert')).toHaveTextContent(firstId);
  fireEvent.click(dialog.getByRole('button', { name: 'Refresh binding records' }));
  expect(await dialog.findByRole('radio', { name: firstId })).toBeDisabled();
  expect(dialog.getByText('Binding state unknown')).toBeInTheDocument();
  expect(dialog.queryByText(/Cancellation confirmed/)).not.toBeInTheDocument();
  fireEvent.click(await selectForReview(dialog, secondId));
  await dialog.findByText(new RegExp('Cancellation of ' + secondId + ' is unconfirmed'));
  expect(dialog.getAllByRole('alert')).toHaveLength(2);
  expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([codes, codes + '/' + firstId + '/cancel', codes, codes + '/' + secondId + '/cancel']);
});

it('allows a pending teardown retry only after refreshing, selecting the same record, and confirming again', async () => {
  const unused = record(firstId);
  const pending = { ...unused, deviceId, usedAt: Date.now(), protocolVersion: 2, cancelledAt: Date.now(), teardownPending: true };
  const fetchMock = vi.fn().mockResolvedValueOnce(page([unused])).mockResolvedValueOnce(errorResponse(500, 'INTERNAL'))
    .mockResolvedValueOnce(page([pending])).mockResolvedValueOnce(response({ recordId: firstId, deviceId }));
  setup(fetchMock);
  const dialog = openDialog('Binding records');
  fireEvent.click(await selectForReview(dialog, firstId));
  await dialog.findByText(/is unconfirmed/);
  fireEvent.click(dialog.getByRole('button', { name: 'Refresh binding records' }));
  const confirm = await selectForReview(dialog, firstId);
  expect(fetchMock).toHaveBeenCalledTimes(3);
  fireEvent.click(confirm);
  expect(await dialog.findByText(/Cancellation confirmed/)).toHaveTextContent(deviceId);
  expect(fetchMock.mock.calls).toEqual([noStoreCall(codes, 'GET'), noStoreCall(codes + '/' + firstId + '/cancel', 'POST'),
    noStoreCall(codes, 'GET'), noStoreCall(codes + '/' + firstId + '/cancel', 'POST')]);
});

it('bounds issuance waiting and ignores a delayed response after timeout', async () => {
  let finish!: (result: Response) => void;
  const fetchMock = vi.fn().mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  setup(fetchMock);
  vi.useFakeTimers();
  const dialog = openDialog('Bind new device');
  const signal = fetchMock.mock.calls[0][1].signal as AbortSignal;
  act(() => { vi.advanceTimersByTime(15_000); });
  expect(signal.aborted).toBe(true);
  expect(dialog.getByRole('alert')).toHaveTextContent('could not be confirmed');
  const data = issued();
  await act(async () => { finish(response(data)); });
  expect(dialog.queryByText(data.code)).not.toBeInTheDocument();
  expect(dialog.getByRole('button', { name: 'Close' })).toBeEnabled();
  expect(fetchMock).toHaveBeenCalledTimes(1);
});
