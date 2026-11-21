import { act, cleanup, render, screen, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import i18n from '../../i18n';
import { useConnection } from '../../realtime/use-admin-socket';
import { DeviceDetails } from './devices';

const now = 1_800_000_000_000;
const id = 'dev_00000000000000000000000001';
const key = ['devices', id];
const device = {
  id, name: 'Synthetic gateway', model: 'Test Model', online: true, lastSeenAt: now, enabled: true,
  callEnabled: false, capabilityLevel: 'L2', sims: [], status: { shizuku: { value: 'running', observedAt: now, stale: false } },
  probes: { uplink: { result: 'fail', probedAt: now, detail: null } },
};
const host = { serial: 'synthetic-usb', lastAt: now, lastResult: 'already_running' };
const snapshot = (usbAutostart: unknown) => ({ data: { ...device, usbAutostart } });
const hostPanel = () => within(screen.getByRole('heading', { name: 'Shizuku USB autostart' }).closest('section')!);

function setup(usbAutostart: unknown) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  client.setQueryData(key, snapshot(usbAutostart));
  render(<QueryClientProvider client={client}><MemoryRouter initialEntries={['/devices/' + id]}><Routes>
    <Route path="/devices/:deviceId" element={<DeviceDetails/>}/>
  </Routes></MemoryRouter></QueryClientProvider>);
  return client;
}

beforeEach(async () => {
  await i18n.changeLanguage('en');
  vi.useFakeTimers();
  vi.setSystemTime(now);
  useConnection.getState().setState('connected');
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Unexpected request')));
});

afterEach(() => {
  cleanup();
  useConnection.getState().setState('disconnected');
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it('keeps USB host results and voice capability independent, then removes the host facts at expiry', () => {
  setup({ ...host, lastAt: now - 30_000 });
  expect(hostPanel().getByText('Host reported already running')).toBeInTheDocument();
  expect(hostPanel().getByText(host.serial)).toBeInTheDocument();
  expect(hostPanel().getByText(/Observed at/)).toBeInTheDocument();
  expect(screen.getByText('Failed')).toBeInTheDocument();
  expect(screen.getByRole('checkbox', { name: 'Calling' })).not.toBeChecked();
  act(() => { vi.advanceTimersByTime(1); });
  expect(hostPanel().getByText('Unknown')).toBeInTheDocument();
  expect(hostPanel().queryByText(host.serial)).not.toBeInTheDocument();
  expect(hostPanel().queryByText(/Observed at/)).not.toBeInTheDocument();
  expect(screen.getByText('Failed')).toBeInTheDocument();
  expect(screen.getByRole('checkbox', { name: 'Calling' })).not.toBeChecked();
  expect(fetch).not.toHaveBeenCalled();
});

it.each([
  ['missing', undefined], ['null', null], ['expired', { ...host, lastAt: now - 30_001 }],
  ['future', { ...host, lastAt: now + 1 }], ['empty serial', { ...host, serial: '' }],
  ['unrecognized result', { ...host, lastResult: 'running' }],
  ['invalid time', { ...host, lastAt: String(now) }],
])('displays an unknown state when host data is %s', (_label, report) => {
  setup(report);
  expect(hostPanel().getByText('Unknown')).toBeInTheDocument();
  expect(hostPanel().queryByText(host.serial)).not.toBeInTheDocument();
  expect(hostPanel().queryByText(/Observed at/)).not.toBeInTheDocument();
});

it('renders a fresh host observation when the admin realtime socket is disconnected', () => {
  useConnection.getState().setState('disconnected');
  setup(host);
  expect(hostPanel().getByText('Host reported already running')).toBeInTheDocument();
  expect(screen.queryByText('Online')).not.toBeInTheDocument();
  expect(screen.queryByText('Failed')).not.toBeInTheDocument();
});

it('accepts a newer host report and expires it using its own timestamp', async () => {
  const client = setup({ ...host, lastResult: 'failed', lastAt: now - 29_999 });
  expect(hostPanel().getByText('Host reported start failure')).toHaveClass('status-err');
  await act(async () => {
    client.setQueryData(key, snapshot({ ...host, lastResult: 'started' }));
    await vi.advanceTimersByTimeAsync(5);
  });
  expect(hostPanel().getByText('Host reported start')).toHaveClass('status-ok');
  act(() => { vi.advanceTimersByTime(29_996); });
  expect(hostPanel().getByText('Unknown')).toBeInTheDocument();
});
