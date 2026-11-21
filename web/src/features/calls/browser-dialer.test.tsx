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

const dialogMethods = (['showModal', 'close'] as const).map(name => ({ name, descriptor: Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, name) }));
beforeEach(async () => {
  await i18n.changeLanguage('en');
  useSession.getState().setSession(session()); prepare.mockReset();
  // jsdom does not supply the platform modal methods.
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value(this: HTMLDialogElement) { this.open = true; } });
  Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value(this: HTMLDialogElement) {
    this.open = false; this.dispatchEvent(new Event('close'));
  } });
});
afterEach(() => {
  cleanup(); client?.clear(); useSession.getState().setSession(null); vi.unstubAllGlobals();
  for (const { name, descriptor } of dialogMethods) {
    if (descriptor) Object.defineProperty(HTMLDialogElement.prototype, name, descriptor);
    else Reflect.deleteProperty(HTMLDialogElement.prototype, name);
  }
});

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
  const mount = () => render(<QueryClientProvider client={client}><MemoryRouter><Calls/></MemoryRouter></QueryClientProvider>);
  return { view: mount(), mount, fetcher, posts: () => fetcher.mock.calls.filter(call => call[1]?.method === 'POST') };
}
const panel = () => within(screen.getByRole('region', { name: 'Browser call' }));
async function confirmHangup() {
  const trigger = panel().getByRole('button', { name: 'Hang up' });
  await waitFor(() => expect(trigger).toBeEnabled());
  fireEvent.click(trigger);
  const dialog = screen.getByRole('dialog', { name: 'Hang up this call?' });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Confirm hangup' }));
}
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
  await panel().findByText(/^Observed call status.*Cellular dialing$/);
  expect(posts()).toHaveLength(1);
  expect(fetcher.mock.calls.filter(call => call[0] === '/api/calls/availability').length).toBeGreaterThanOrEqual(2);
  expect(new Headers(posts()[0][1]?.headers).get('Idempotency-Key')).toMatch(/^[0-9A-Z]{26}$/);
  expect(new Headers(posts()[0][1]?.headers).get('Authorization')).toBe('Bearer fixture-admin-token');
  expect(JSON.parse(String(posts()[0][1]?.body))).toEqual({ simId: sim, to: dest });
  expect(prepared.attach).toHaveBeenCalledWith(mediaPath, mediaToken, expect.anything());
  expect(panel().getByRole('button', { name: 'Send keypad digits' })).toBeDisabled();
  callState = 'bridged';
  await act(async () => { await client.invalidateQueries({ queryKey: ['calls', id, 'browser-control'] }); });
  await panel().findByText(/^Observed call status.*Bridge recorded$/);
  fireEvent.change(panel().getByLabelText('Keypad digits'), { target: { value: '*1#' } });
  fireEvent.click(panel().getByRole('button', { name: 'Send keypad digits' }));
  await panel().findByText(/Delivery to the remote party is unconfirmed/);
  expect(posts()[1][0]).toBe('/api/calls/' + id + '/dtmf');
  expect(JSON.parse(String(posts()[1][1]?.body))).toEqual({ digits: '*1#' });
  await confirmHangup();
  await panel().findByText(/Waiting for a stored call outcome/);
  expect(posts()[2][0]).toBe('/api/calls/' + id + '/hangup');
  expect(panel().getByText(/^Observed call status.*Bridge recorded$/)).toBeInTheDocument();
  expect(panel().getByRole('button', { name: 'Hang up' })).toBeDisabled();
  expect(prepared.close).not.toHaveBeenCalled();
  callState = 'ended';
  await act(async () => { await client.invalidateQueries({ queryKey: ['calls', id, 'browser-control'] }); });
  await panel().findByText(/Observed call status.*Ended/);
  await waitFor(() => expect(prepared.close).toHaveBeenCalledOnce());
});

it('requires confirmation after local audio loss and never infers terminal state from a hangup ACK', async () => {
  const prepared = audio(); prepare.mockResolvedValueOnce(prepared);
  let state = 'bridged';
  const { posts } = setup((url, init) => {
    if (url === summaryUrl) return data(observed(state));
    if (url.endsWith('/hangup') && init?.method === 'POST') return data({});
  });
  await clickDial(); await panel().findByText(/^Observed call status.*Bridge recorded$/);
  fireEvent.click(panel().getByRole('button', { name: 'Disconnect browser audio' }));
  expect(prepared.close).toHaveBeenCalledOnce();
  expect(posts()).toHaveLength(1);
  expect(panel().getByRole('button', { name: 'Send keypad digits' })).toBeDisabled();
  const trigger = panel().getByRole('button', { name: 'Hang up' });
  expect(trigger).toBeEnabled();
  fireEvent.click(trigger);
  const dialog = screen.getByRole('dialog', { name: 'Hang up this call?' });
  const close = within(dialog).getByRole('button', { name: 'Close' });
  expect(close).toHaveFocus();
  expect(posts()).toHaveLength(1);
  fireEvent.click(close);
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(posts()).toHaveLength(1);
  await confirmHangup();
  await panel().findByText(/Waiting for a stored call outcome/);
  expect(posts().map(([url]) => url)).toEqual(['/api/calls', '/api/calls/' + id + '/hangup']);
  expect(panel().getByText(/^Observed call status.*Bridge recorded$/)).toBeInTheDocument();
  expect(trigger).toBeDisabled();
  state = 'ended';
  await act(async () => { await client.invalidateQueries({ queryKey: ['calls', id, 'browser-control'] }); });
  await panel().findByText(/Observed call status.*Ended/);
  expect(prepared.close).toHaveBeenCalledOnce();
});

it('keeps an interrupted hangup unknown across remounts and fences a late success reply', async () => {
  const prepared = audio(); prepare.mockResolvedValueOnce(prepared);
  let resolveHangup!: (response: Response) => void;
  const { posts, view, mount } = setup((url, init) => {
    if (url === summaryUrl) return data(observed('bridged'));
    if (url.endsWith('/hangup') && init?.method === 'POST') return new Promise(resolve => { resolveHangup = resolve; });
  });
  await clickDial(); await panel().findByText(/^Observed call status.*Bridge recorded$/);
  await confirmHangup();
  await waitFor(() => expect(posts()).toHaveLength(2));
  const sentSignal = posts()[1]?.[1]?.signal;
  expect(sentSignal?.aborted).toBe(false);
  view.unmount();
  expect(sentSignal?.aborted).toBe(true);
  expect(prepared.close).toHaveBeenCalledOnce();
  mount();
  await panel().findByText(/hangup outcome is unknown/);
  expect(panel().getByRole('button', { name: 'Hang up' })).toBeDisabled();
  expect(panel().getByRole('button', { name: 'Send keypad digits' })).toBeDisabled();
  await act(async () => { resolveHangup(data({})); });
  expect(panel().getByText(/hangup outcome is unknown/)).toBeInTheDocument();
  expect(panel().queryByText(/Hangup request accepted/)).not.toBeInTheDocument();
  expect(posts()).toHaveLength(2);
});

it('marks a timed-out hangup unknown even when fetch ignores abort and returns success later', async () => {
  prepare.mockResolvedValueOnce(audio());
  let resolveHangup!: (response: Response) => void;
  const { posts } = setup((url, init) => {
    if (url === summaryUrl) return data(observed('bridged'));
    if (url.endsWith('/hangup') && init?.method === 'POST') return new Promise(resolve => { resolveHangup = resolve; });
  });
  await clickDial(); await panel().findByText(/^Observed call status.*Bridge recorded$/);
  const trigger = panel().getByRole('button', { name: 'Hang up' });
  expect(trigger).toBeEnabled();
  fireEvent.click(trigger);
  const modal = screen.getByRole('dialog', { name: 'Hang up this call?' });
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  try {
    fireEvent.click(within(modal).getByRole('button', { name: 'Confirm hangup' }));
    expect(posts()).toHaveLength(2);
    const signal = posts()[1]?.[1]?.signal;
    await act(async () => { await vi.advanceTimersByTimeAsync(11_999); });
    expect(signal?.aborted).toBe(false);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(signal?.aborted).toBe(true);
    expect(panel().getByText(/hangup outcome is unknown/)).toBeInTheDocument();
    await act(async () => { resolveHangup(data({})); await vi.advanceTimersByTimeAsync(1); });
    expect(panel().getByText(/hangup outcome is unknown/)).toBeInTheDocument();
    expect(panel().queryByText(/Hangup request accepted/)).not.toBeInTheDocument();
    expect(trigger).toBeDisabled();
    expect(posts()).toHaveLength(2);
  } finally { vi.useRealTimers(); }
});

it('keeps an acknowledged hangup locked on same-session revisit until stored signalling changes', async () => {
  prepare.mockResolvedValueOnce(audio());
  let state = 'bridged';
  const { posts, view, mount } = setup((url, init) => {
    if (url === summaryUrl) return data(observed(state));
    if (url.endsWith('/hangup') && init?.method === 'POST') return data({});
  });
  await clickDial(); await panel().findByText(/^Observed call status.*Bridge recorded$/);
  await confirmHangup(); await panel().findByText(/Waiting for a stored call outcome/);
  view.unmount(); mount();
  await panel().findByText(/Waiting for a stored call outcome/);
  expect(panel().getByRole('button', { name: 'Hang up' })).toBeDisabled();
  state = 'ended';
  const refresh = panel().getByRole('button', { name: 'Refresh call status' });
  await waitFor(() => expect(refresh).toBeEnabled());
  fireEvent.click(refresh);
  await panel().findByText(/^Observed call status.*Ended$/);
  expect(panel().queryByText(/Waiting for a stored call outcome/)).not.toBeInTheDocument();
  expect(posts().map(([url]) => url)).toEqual(['/api/calls', '/api/calls/' + id + '/hangup']);
});

it('allows a deliberate hangup after same-session remount without preparing audio again', async () => {
  const prepared = audio(); prepare.mockResolvedValueOnce(prepared);
  const { posts, view, mount } = setup((url, init) => {
    if (url === summaryUrl) return data(observed('cell_dialing'));
    if (url.endsWith('/hangup') && init?.method === 'POST') return data({});
  });
  await clickDial(); await panel().findByText(/^Observed call status.*Cellular dialing$/);
  view.unmount(); mount();
  await panel().findByText(/Browser audio is not attached/);
  await confirmHangup();
  await panel().findByText(/Waiting for a stored call outcome/);
  expect(prepare).toHaveBeenCalledOnce();
  expect(posts().map(([url]) => url)).toEqual(['/api/calls', '/api/calls/' + id + '/hangup']);
});

it('does not submit a hangup from a read that expired while the confirmation was open', async () => {
  prepare.mockResolvedValueOnce(audio());
  const { posts, fetcher } = setup(url => url === summaryUrl ? data(observed('bridged')) : undefined);
  await clickDial(); await panel().findByText(/^Observed call status.*Bridge recorded$/);
  fireEvent.click(panel().getByRole('button', { name: 'Hang up' }));
  const dialog = screen.getByRole('dialog', { name: 'Hang up this call?' });
  const before = fetcher.mock.calls.filter(([url]) => url === summaryUrl).length;
  const expired = client.getQueryState(['calls', id, 'browser-control'])!.dataUpdatedAt + 5_001;
  const clock = vi.spyOn(Date, 'now').mockReturnValue(expired);
  try { fireEvent.click(within(dialog).getByRole('button', { name: 'Confirm hangup' })); }
  finally { clock.mockRestore(); }
  expect(posts()).toHaveLength(1);
  expect(panel().getByText(/No control request was sent/)).toBeInTheDocument();
  await waitFor(() => expect(fetcher.mock.calls.filter(([url]) => url === summaryUrl).length).toBeGreaterThan(before));
  expect(posts()).toHaveLength(1);
});

it('does not reuse cached call state to enable hangup before a same-session remount reads back', async () => {
  prepare.mockResolvedValueOnce(audio());
  let hold = false;
  let finishRead!: (response: Response) => void;
  const { posts, view, mount } = setup(url => url === summaryUrl ? (hold ? new Promise(resolve => { finishRead = resolve; }) : data(observed('bridged'))) : undefined);
  await clickDial(); await panel().findByText(/^Observed call status.*Bridge recorded$/);
  hold = true; view.unmount(); mount();
  await waitFor(() => expect(finishRead).toBeDefined());
  expect(panel().getByRole('button', { name: 'Hang up' })).toBeDisabled();
  expect(posts()).toHaveLength(1);
  hold = false;
  await act(async () => { finishRead(data(observed('bridged'))); });
  await waitFor(() => expect(panel().getByRole('button', { name: 'Hang up' })).toBeEnabled());
  expect(posts()).toHaveLength(1);
});

it('rechecks call state at confirmation and does not apply a stale modal after the call ends', async () => {
  const prepared = audio(); prepare.mockResolvedValueOnce(prepared);
  let state = 'bridged';
  const { posts } = setup(url => url === summaryUrl ? data(observed(state)) : undefined);
  await clickDial(); await panel().findByText(/^Observed call status.*Bridge recorded$/);
  fireEvent.click(panel().getByRole('button', { name: 'Hang up' }));
  const dialog = screen.getByRole('dialog', { name: 'Hang up this call?' });
  const confirm = within(dialog).getByRole('button', { name: 'Confirm hangup' });
  state = 'ended';
  await act(async () => { await client.invalidateQueries({ queryKey: ['calls', id, 'browser-control'] }); });
  await panel().findByText(/Observed call status.*Ended/);
  fireEvent.click(confirm);
  expect(posts()).toHaveLength(1);
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
});

it('abandons the old call and modal on administrator session replacement', async () => {
  const prepared = audio(); prepare.mockResolvedValueOnce(prepared);
  const { posts } = setup(url => url === summaryUrl ? data(observed('bridged')) : undefined);
  await clickDial(); await panel().findByText(/^Observed call status.*Bridge recorded$/);
  fireEvent.click(panel().getByRole('button', { name: 'Hang up' }));
  const modal = screen.getByRole('dialog', { name: 'Hang up this call?' });
  const staleButton = within(modal).getByRole('button', { name: 'Confirm hangup' });
  act(() => useSession.getState().setSession(session('replacement-fixture-token')));
  fireEvent.click(staleButton);
  expect(posts()).toHaveLength(1);
  expect(prepared.close).toHaveBeenCalledOnce();
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
});

it('keeps a lost keypad request locked after audio loss but leaves a confirmed hangup available', async () => {
  const prepared = audio(); prepare.mockResolvedValueOnce(prepared);
  let resolveDtmf!: (response: Response) => void;
  const { posts } = setup((url, init) => {
    if (url === summaryUrl) return data(observed('bridged'));
    if (url.endsWith('/dtmf') && init?.method === 'POST') return new Promise(resolve => { resolveDtmf = resolve; });
    if (url.endsWith('/hangup') && init?.method === 'POST') return data({});
  });
  await clickDial(); await panel().findByText(/^Observed call status.*Bridge recorded$/);
  fireEvent.change(panel().getByLabelText('Keypad digits'), { target: { value: '1' } });
  fireEvent.click(panel().getByRole('button', { name: 'Send keypad digits' }));
  await waitFor(() => expect(posts()).toHaveLength(2));
  const onClosed = prepared.attach.mock.calls[0]?.[2]?.onClosed as (() => void) | undefined;
  if (!onClosed) throw Error('Missing audio loss callback');
  act(() => onClosed());
  expect(panel().getByRole('button', { name: 'Hang up' })).toBeDisabled();
  await act(async () => { resolveDtmf(error('TIMEOUT_UNKNOWN', 504)); });
  await panel().findByText(/keypad request outcome is unknown/);
  expect(panel().getByRole('button', { name: 'Send keypad digits' })).toBeDisabled();
  await confirmHangup();
  await panel().findByText(/Waiting for a stored call outcome/);
  expect(posts().map(([url]) => url)).toEqual(['/api/calls', '/api/calls/' + id + '/dtmf', '/api/calls/' + id + '/hangup']);
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
