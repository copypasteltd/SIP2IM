import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import i18n from '../../i18n';
import { SettingsPage } from './settings';

const deviceId = 'dev_01ARZ3NDEKTSV4RRFFQ69G5FAV';
const base = { smsForward: false, smsRatePerMin: 10 as number | null, heartbeatSec: 30, offlineAfterSec: 90, botLocale: 'en', defaultDeviceId: deviceId as string | null, inboundRingTimeoutSec: 20, outboundUserAnswerTimeoutSec: 15, outboundCalleeAnswerTimeoutSec: 30, outboundCallbackRingTimeoutSec: 30, alertPushIntervalSec: 1800, earlyMediaThresholdDbfs: -50, inboundPlatform: 'telegram' };
const response = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
const error = (code: string, status: number) => response({ error: { code, message: code, details: null } }, status);
let client: QueryClient;

afterEach(() => { cleanup(); client?.clear(); vi.unstubAllGlobals(); });
function setup(get: () => Response | Promise<Response>, put: () => Response | Promise<Response>) {
  client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 30_000 }, mutations: { retry: 5 } } });
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.startsWith('/api/devices?') && init?.method === 'GET') return response({ data: [{ id: deviceId, name: 'Desk device' }], nextCursor: null });
    if (url === '/api/settings' && init?.method === 'GET') return get();
    if (url === '/api/settings/conditional' && init?.method === 'PUT') return put();
    return error('UNEXPECTED_TEST_ROUTE', 404);
  });
  vi.stubGlobal('fetch', fetcher);
  const component = () => <QueryClientProvider client={client}><SettingsPage/></QueryClientProvider>;
  const view = render(component());
  return { remount: () => { view.unmount(); render(component()); }, fetcher, writes: () => fetcher.mock.calls.filter(call => call[1]?.method === 'PUT'), reads: () => fetcher.mock.calls.filter(call => call[0] === '/api/settings') };
}
const save = (section: string) => within(screen.getByRole('heading', { name: section }).closest('form')!).getByRole('button', { name: 'Save' });
const heartbeat = () => screen.getByLabelText('Heartbeat interval (seconds)');

it('preserves scalar types and only compares exactly the changed nullable settings', async () => {
  await i18n.changeLanguage('en');
  let current = base;
  const { writes, reads } = setup(() => response({ data: current }), () => response({ data: current }));
  const rate = await screen.findByLabelText('Messages per minute (blank disables)');
  fireEvent.change(rate, { target: { value: '' } });
  current = { ...base, smsRatePerMin: null };
  fireEvent.click(save('Message settings'));
  await waitFor(() => { expect(reads()).toHaveLength(2); expect(rate).toBeEnabled(); expect(save('Message settings')).toBeDisabled(); });
  expect(JSON.parse(String(writes()[0][1]?.body))).toEqual({ changes: { smsRatePerMin: null }, expected: { smsRatePerMin: 10 } });
  fireEvent.change(rate, { target: { value: '12' } });
  current = { ...current, smsRatePerMin: 12 };
  fireEvent.click(save('Message settings'));
  await waitFor(() => { expect(reads()).toHaveLength(3); expect(rate).toBeEnabled(); expect(save('Message settings')).toBeDisabled(); });
  expect(writes()).toHaveLength(2);
  expect(JSON.parse(String(writes()[1][1]?.body))).toEqual({ changes: { smsRatePerMin: 12 }, expected: { smsRatePerMin: null } });
  const device = await screen.findByLabelText('Default device');
  await screen.findByRole('option', { name: 'Desk device' });
  fireEvent.change(device, { target: { value: '' } });
  current = { ...current, defaultDeviceId: null };
  fireEvent.click(save('Default device'));
  await waitFor(() => { expect(reads()).toHaveLength(4); expect(device).toBeEnabled(); expect(save('Default device')).toBeDisabled(); });
  expect(JSON.parse(String(writes()[2][1]?.body))).toEqual({ changes: { defaultDeviceId: null }, expected: { defaultDeviceId: deviceId } });
});

it('refreshes after a real conflict and ignores a late pre-conflict background read', async () => {
  await i18n.changeLanguage('en');
  let reads = 0;
  let finishOld!: (value: Response) => void;
  let finishFresh!: (value: Response) => void;
  const { writes, reads: gets } = setup(() => {
    if (++reads === 1) return response({ data: base });
    if (reads === 2) return new Promise<Response>(resolve => { finishOld = resolve; });
    if (reads === 3) return new Promise<Response>(resolve => { finishFresh = resolve; });
    return response({ data: { ...base, heartbeatSec: 40 } });
  }, () => writes().length === 1 ? error('SETTINGS_CONFLICT', 409) : response({ data: { ...base, heartbeatSec: 40 } }));
  fireEvent.change(await screen.findByLabelText('Heartbeat interval (seconds)'), { target: { value: '40' } });
  void client.invalidateQueries({ queryKey: ['settings'], exact: true });
  await waitFor(() => expect(reads).toBe(2));
  fireEvent.click(save('Timing settings'));
  await waitFor(() => expect(reads).toBe(3));
  expect(gets()[1][1]?.signal?.aborted).toBe(true);
  expect(gets()[2][1]?.cache).toBe('no-store');
  expect(save('Timing settings')).toBeDisabled();
  await act(async () => { finishFresh(response({ data: { ...base, heartbeatSec: 55, offlineAfterSec: 105 } })); });
  await waitFor(() => expect(screen.getByRole('button', { name: 'Keep my edit' })).toBeEnabled());
  await act(async () => { finishOld(response({ data: base })); });
  expect(heartbeat()).toHaveValue(40);
  expect(screen.getByLabelText('Offline threshold (seconds)')).toHaveValue(105);
  expect(save('Timing settings')).toBeDisabled();
  expect(writes()).toHaveLength(1);
  fireEvent.click(screen.getByRole('button', { name: 'Keep my edit' }));
  fireEvent.click(save('Timing settings'));
  await waitFor(() => expect(writes()).toHaveLength(2));
  expect(JSON.parse(String(writes()[1][1]?.body))).toEqual({ changes: { heartbeatSec: 40 }, expected: { heartbeatSec: 55 } });
});

it('blocks both settings groups after an unknown write and never replays it after a read', async () => {
  await i18n.changeLanguage('en');
  let latest = base;
  const { writes, reads, remount } = setup(() => response({ data: latest }), () => error('SETTINGS_WRITE_OUTCOME_UNKNOWN', 503));
  fireEvent.change(await screen.findByLabelText('Heartbeat interval (seconds)'), { target: { value: '40' } });
  fireEvent.change(screen.getByLabelText('Incoming ring timeout (seconds)'), { target: { value: '25' } });
  fireEvent.click(save('Timing settings'));
  await screen.findByText(/save result may be uncertain/i);
  expect(heartbeat()).toHaveValue(40);
  expect(save('Call and alert timing')).toBeDisabled();
  expect(reads()).toHaveLength(1);
  latest = { ...base, heartbeatSec: 50 };
  fireEvent.click(screen.getByRole('button', { name: 'Refresh settings' }));
  const acknowledge = await screen.findByRole('button', { name: /I have investigated/i });
  expect(heartbeat()).toHaveValue(40);
  expect(save('Timing settings')).toBeDisabled();
  expect(writes()).toHaveLength(1);
  remount();
  expect(heartbeat()).toHaveValue(40);
  expect(acknowledge).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: /I have investigated/i }));
  expect(save('Timing settings')).toBeDisabled();
  await waitFor(() => expect(screen.getByRole('button', { name: 'Keep my edit' })).toBeEnabled());
  expect(writes()).toHaveLength(1);
});

it('does not fall back to the unconditional writer when conditional support is missing', async () => {
  await i18n.changeLanguage('en');
  const { writes } = setup(() => response({ data: base }), () => error('NOT_FOUND', 404));
  fireEvent.change(await screen.findByLabelText('Heartbeat interval (seconds)'), { target: { value: '40' } });
  fireEvent.click(save('Timing settings'));
  await screen.findByText(/conditional saving is unavailable/i);
  expect(heartbeat()).toHaveValue(40);
  expect(writes().map(call => call[0])).toEqual(['/api/settings/conditional']);
});
