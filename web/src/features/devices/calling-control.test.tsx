import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import i18n from '../../i18n';
import { DeviceDetails } from './devices';

const device = { id: 'dev/1', name: 'Gateway', model: 'Test', online: true, lastSeenAt: null, enabled: true, paused: false, callEnabled: false, capabilityLevel: 'L3', sims: [], probes: {}, status: {} };
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
async function setup(fetchMock: typeof fetch) {
  await i18n.changeLanguage('en');
  vi.stubGlobal('fetch', fetchMock);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(<QueryClientProvider client={client}><MemoryRouter initialEntries={['/devices/dev%2F1']}><Routes><Route path="/devices/:deviceId" element={<DeviceDetails/>}/></Routes></MemoryRouter></QueryClientProvider>);
  return await screen.findByRole('checkbox', { name: 'Calling' });
}
const response = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });

it('updates calling through PATCH and reflects the refreshed server state in both directions', async () => {
  let current = false;
  const fetchMock = vi.fn(async (_url: string, options: RequestInit) => {
    if (options.method === 'PATCH') current = JSON.parse(String(options.body)).callEnabled;
    return response({ data: { ...device, callEnabled: current } });
  });
  const checkbox = await setup(fetchMock as unknown as typeof fetch);
  expect(checkbox).not.toBeChecked();
  fireEvent.click(checkbox);
  await waitFor(() => expect(checkbox).toBeChecked());
  fireEvent.click(checkbox);
  await waitFor(() => expect(checkbox).not.toBeChecked());
  const patches = fetchMock.mock.calls.filter(([, options]) => options.method === 'PATCH');
  expect(patches.map(([url, options]) => [url, JSON.parse(String(options.body))])).toEqual([
    ['/api/devices/dev%2F1', { callEnabled: true }], ['/api/devices/dev%2F1', { callEnabled: false }],
  ]);
});

it('disables the control until the update and refresh finish', async () => {
  let finish!: (value: Response) => void;
  const pending = new Promise<Response>(resolve => { finish = resolve; });
  const fetchMock = vi.fn(async (_url: string, options: RequestInit) => options.method === 'PATCH'
    ? pending : response({ data: device }));
  const checkbox = await setup(fetchMock as unknown as typeof fetch);
  fireEvent.click(checkbox);
  await waitFor(() => expect(checkbox).toBeDisabled());
  expect(screen.getByRole('status')).toHaveTextContent('Loading');
  expect(checkbox).not.toBeChecked();
  finish(response({ data: { ...device, callEnabled: true } }));
  await waitFor(() => expect(checkbox).toBeEnabled());
  expect(fetchMock.mock.calls.filter(([, options]) => options.method === 'PATCH')).toHaveLength(1);
});

it('reconciles a committed write when the response is lost', async () => {
  let current = false;
  const fetchMock = vi.fn(async (_url: string, options: RequestInit) => {
    if (options.method === 'PATCH') { current = true; throw new Error('connection lost'); }
    return response({ data: { ...device, callEnabled: current } });
  });
  const checkbox = await setup(fetchMock as unknown as typeof fetch);
  fireEvent.click(checkbox);
  expect(await screen.findByRole('alert')).toBeInTheDocument();
  await waitFor(() => expect(screen.getByRole('checkbox', { name: 'Calling' })).toBeChecked());
  expect(fetchMock.mock.calls.filter(([, options]) => options.method === 'PATCH')).toHaveLength(1);
});

it('blocks writes after failed reconciliation and permits only a read retry', async () => {
  let reads = 0;
  const fetchMock = vi.fn(async (_url: string, options: RequestInit) => {
    if (options.method === 'PATCH') throw new Error('response lost');
    reads++;
    if (reads === 2) throw new Error('read failed');
    return response({ data: { ...device, callEnabled: reads > 2 } });
  });
  fireEvent.click(await setup(fetchMock as unknown as typeof fetch));
  expect(await screen.findByRole('button', { name: 'Retry' })).toBeInTheDocument();
  expect(screen.queryByRole('checkbox', { name: 'Calling' })).not.toBeInTheDocument();
  expect(screen.getByText('Calling: Unknown')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
  expect(await screen.findByRole('checkbox', { name: 'Calling' })).toBeChecked();
  expect(fetchMock.mock.calls.filter(([, options]) => options.method === 'PATCH')).toHaveLength(1);
});
