import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import i18n from '../../i18n';
import { useSession } from '../../stores/session';
import { prepareCallAudio } from '../../audio/call-audio';
import { Calls } from './calls';

vi.mock('../../audio/secure-context', () => ({ microphoneAvailable: () => true }));
vi.mock('../../audio/call-audio', () => ({ prepareCallAudio: vi.fn() }));
const dev = 'dev_01ARZ3NDEKTSV4RRFFQ69G5FAV';
const sim = 'sim_01ARZ3NDEKTSV4RRFFQ69G5FAW';
const id = 'ses_01ARZ3NDEKTSV4RRFFQ69G5FAX';
const legId = 'leg_01ARZ3NDEKTSV4RRFFQ69G5FAY';
const summaryUrl = '/api/calls/' + id + '/summary';
const dest = 'fixture-destination';
const mediaPath = '/ws/media?session=' + id + '&leg=' + legId;
const mediaToken = 'A'.repeat(43);
const observed = (state: string) => ({ id, deviceId: dev, simId: sim, kind: 'web_out', state, legs: [{ id: legId, type: 'browser', state: 'connected' }] });
const data = (value: unknown) => new Response(JSON.stringify({ data: value }), { status: 200 });
const error = (code: string, status: number) => new Response(JSON.stringify({ error: { code } }), { status });
const receipt = (path = mediaPath) => data({ session: observed('awaiting_browser'), browserLeg: { legId, mediaPath: path, mediaToken } });
const session = (token = 'fixture-admin-token') => ({ token, expiresAt: Date.now() + 60_000, username: 'fixture' });
let client: QueryClient;
const prepare = vi.mocked(prepareCallAudio);
const audio = () => ({ attach: vi.fn(), close: vi.fn(), usable: vi.fn(() => true) });

beforeEach(async () => { await i18n.changeLanguage('en'); useSession.getState().setSession(session()); prepare.mockReset(); });
afterEach(() => { cleanup(); client?.clear(); useSession.getState().setSession(null); vi.unstubAllGlobals(); });

function setup(override: (url: string, init?: RequestInit) => Response | Promise<Response> | undefined = () => undefined) {
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: 3 } } });
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    const result = override(url, init);
    if (result) return result;
    if (url === '/api/calls/availability') return data({ deviceIds: [dev] });
    if (url === '/api/devices?limit=50') return data([{ id: dev, name: 'Fixture handset', online: true, enabled: true, paused: false, callEnabled: true, sims: [{ id: sim, slot: 0, state: 'ready', lastSeenAt: Date.now() - 10_000 }] }]);
    if (url === '/api/calls?limit=50') return data([]);
    if (url === summaryUrl) return data(observed('awaiting_browser'));
    if (url === '/api/calls' && init?.method === 'POST') return receipt();
    return error('UNEXPECTED_FIXTURE_ROUTE', 404);
  });
  vi.stubGlobal('fetch', fetcher);
  const view = render(<QueryClientProvider client={client}><MemoryRouter><Calls/></MemoryRouter></QueryClientProvider>);
  return { view, fetcher, posts: () => fetcher.mock.calls.filter(call => call[1]?.method === 'POST') };
}
const panel = () => within(screen.getByRole('region', { name: 'Browser call' }));
async function clickDial() {
  await panel().findByRole('option', { name: /^Fixture handset/ });
  fireEvent.change(panel().getByLabelText('Calling SIM'), { target: { value: sim } });
  fireEvent.change(panel().getByLabelText('Destination number'), { target: { value: dest } });
  fireEvent.click(panel().getByRole('button', { name: 'Dial from browser' }));
}

it.each([false, true])('fails closed when availability is absent or empty (empty=%s)', async empty => {
  const { fetcher, posts } = setup(url => url === '/api/calls/availability' ? (empty ? data({ deviceIds: [] }) : error('NOT_FOUND', 404)) : undefined);
  await panel().findByText(/Browser dialing is unavailable/);
  expect(panel().queryByRole('button', { name: 'Dial from browser' })).toBeNull();
  expect(fetcher.mock.calls.some(([url]) => url.startsWith('/api/devices'))).toBe(false);
  expect(posts()).toHaveLength(0);
  expect(prepare).not.toHaveBeenCalled();
});

it('prepares audio before reserving, uses the exact returned leg, and waits for a stored hangup result', async () => {
  const prepared = audio();
  let finishPreparation!: (value: ReturnType<typeof audio>) => void;
  prepare.mockImplementation(() => new Promise(resolve => { finishPreparation = resolve; }));
  let callState = 'cell_dialing';
  const { posts, fetcher } = setup((url, init) => {
    if (url === summaryUrl) return data(observed(callState));
    if (init?.method === 'POST' && (url.endsWith('/hangup') || url.endsWith('/dtmf'))) return data({});
  });
  await clickDial();
  expect(prepare).toHaveBeenCalledOnce();
  expect(posts()).toHaveLength(0);
  await act(async () => { finishPreparation(prepared); });
  await panel().findByText(/Cellular dialing/);
  expect(posts()).toHaveLength(1);
  expect(fetcher.mock.calls.filter(call => call[0] === '/api/calls/availability').length).toBeGreaterThanOrEqual(2);
  expect(new Headers(posts()[0][1]?.headers).get('Idempotency-Key')).toMatch(/^[0-9A-Z]{26}$/);
  expect(new Headers(posts()[0][1]?.headers).get('Authorization')).toBe('Bearer fixture-admin-token');
  expect(JSON.parse(String(posts()[0][1]?.body))).toEqual({ simId: sim, to: dest });
  expect(prepared.attach).toHaveBeenCalledWith(mediaPath, mediaToken, expect.anything());
  expect(panel().getByRole('button', { name: 'Send keypad digits' })).toBeDisabled();
  callState = 'bridged';
  await act(async () => { await client.invalidateQueries({ queryKey: ['calls', id, 'browser-control'] }); });
  await panel().findByText(/Bridge recorded/);
  fireEvent.change(panel().getByLabelText('Keypad digits'), { target: { value: '*1#' } });
  fireEvent.click(panel().getByRole('button', { name: 'Send keypad digits' }));
  await panel().findByText(/Delivery to the remote party is unconfirmed/);
  expect(posts()[1][0]).toBe('/api/calls/' + id + '/dtmf');
  expect(JSON.parse(String(posts()[1][1]?.body))).toEqual({ digits: '*1#' });
  fireEvent.click(panel().getByRole('button', { name: 'Hang up' }));
  await panel().findByText(/Waiting for a stored call outcome/);
  expect(posts()[2][0]).toBe('/api/calls/' + id + '/hangup');
  expect(panel().getByText(/Bridge recorded/)).toBeInTheDocument();
  expect(panel().getByRole('button', { name: 'Hang up' })).toBeDisabled();
  expect(prepared.close).not.toHaveBeenCalled();
  callState = 'ended';
  await act(async () => { await client.invalidateQueries({ queryKey: ['calls', id, 'browser-control'] }); });
  await panel().findByText(/Observed call status.*Ended/);
  await waitFor(() => expect(prepared.close).toHaveBeenCalledOnce());
});

it('keeps the original key and body after an unknown reservation and resumes only by explicit action', async () => {
  const first = audio(); const second = audio();
  prepare.mockResolvedValueOnce(first).mockResolvedValueOnce(second);
  let requests = 0;
  const { posts } = setup((url, init) => url === '/api/calls' && init?.method === 'POST' ? (++requests === 1 ? error('TIMEOUT_UNKNOWN', 504) : receipt()) : undefined);
  await clickDial();
  await panel().findByText(/reservation outcome is unknown/);
  expect(first.close).toHaveBeenCalledOnce();
  expect(posts()).toHaveLength(1);
  fireEvent.click(panel().getByRole('button', { name: 'Resume this call attempt' }));
  await waitFor(() => expect(second.attach).toHaveBeenCalledOnce());
  expect(posts()).toHaveLength(2);
  expect(new Headers(posts()[0][1]?.headers).get('Idempotency-Key')).toBe(new Headers(posts()[1][1]?.headers).get('Idempotency-Key'));
  expect(posts()[0][1]?.body).toBe(posts()[1][1]?.body);
});

it('does not reserve if permission is denied or availability drops during audio preparation', async () => {
  prepare.mockRejectedValueOnce(new DOMException('fixture denied', 'NotAllowedError'));
  const prepared = audio(); prepare.mockResolvedValueOnce(prepared);
  let availabilityReads = 0;
  const { posts } = setup(url => url === '/api/calls/availability' ? data({ deviceIds: ++availabilityReads === 1 ? [dev] : [] }) : undefined);
  await clickDial();
  await panel().findByText(/Could not prepare browser audio/);
  expect(posts()).toHaveLength(0);
  fireEvent.click(panel().getByRole('button', { name: 'Dial from browser' }));
  await panel().findByText(/Calling availability could not be verified/);
  expect(posts()).toHaveLength(0);
  expect(prepared.close).toHaveBeenCalledOnce();
});

it('drops an old reservation reply and releases audio on session replacement', async () => {
  const prepared = audio(); prepare.mockResolvedValueOnce(prepared);
  let reply!: (value: Response) => void;
  const { posts } = setup((url, init) => url === '/api/calls' && init?.method === 'POST' ? new Promise(resolve => { reply = resolve; }) : undefined);
  await clickDial();
  await waitFor(() => expect(reply).toBeDefined());
  act(() => useSession.getState().setSession(session('replacement-token')));
  expect(posts()[0][1]?.signal?.aborted).toBe(true);
  expect(prepared.close).toHaveBeenCalledOnce();
  await act(async () => { reply(receipt()); });
  expect(prepared.attach).not.toHaveBeenCalled();
  expect(posts()).toHaveLength(1);
});

it('rejects a mismatched media path without attaching or redialing', async () => {
  const prepared = audio(); prepare.mockResolvedValueOnce(prepared);
  const { posts } = setup((url, init) => url === '/api/calls' && init?.method === 'POST' ? receipt(mediaPath + '&leg=wrong') : undefined);
  await clickDial();
  await panel().findByText(/reservation outcome is unknown/);
  expect(prepared.attach).not.toHaveBeenCalled();
  expect(prepared.close).toHaveBeenCalledOnce();
  expect(posts()).toHaveLength(1);
});
