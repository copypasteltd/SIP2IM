import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AppProviders } from '../../app/providers';
import { ChannelActions } from './channel-actions';
import { useLoginSteps } from '../../realtime/login-steps';
import { useConnection } from '../../realtime/use-admin-socket';
import { useSession } from '../../stores/session';
import i18n from '../../i18n';
import type { Channel } from '../../api/management';

vi.mock('../../realtime/admin-socket', () => ({ startAdminSocket: () => () => {} }));

const channel: Channel = { platform: 'telegram', state: 'logged_out', alias: null, voiceVerified: false, isInbound: false, pairedUser: null, capabilities: { login: true, sendMessage: false, receiveMessage: false, dial: false, receiveAudio: false, sendAudio: false, maxConcurrentCalls: 0 } };
const response = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
const show = (value = channel) => render(<AppProviders><ChannelActions channel={value}/></AppProviders>);
const firstId='00000000-0000-4000-8000-000000000001';
const secondId='00000000-0000-4000-8000-000000000002';
const stepUrl='/api/channels/telegram/login/step';
const fixtureSession=(token='fixture-admin')=>({token,username:'offline fixture',expiresAt:Date.now()+300_000});
const stepFixture=(challengeId:string,step:'code'|'password'='code')=>({challengeId,step,qrPngBase64:null,hint:null});
const observe = (step: 'code' | 'password' = 'code', challengeId=firstId) => act(() => useLoginSteps.getState().observeStep('telegram', stepFixture(challengeId,step)));
function mockReads(read:()=>Response|Promise<Response>, unknown=false) {
  const fetcher=vi.fn(async (...args:[string,RequestInit?]) => args[0]===stepUrl ? read() :
    unknown && args[0].endsWith('/submit') ? response({error:{code:'TIMEOUT_UNKNOWN'}},504) : response({data:{}}));
  vi.stubGlobal('fetch',fetcher);
  return fetcher;
}
async function start(step: 'code' | 'password' = 'code') {
  fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
  await waitFor(() => expect(useLoginSteps.getState().progress.telegram).toMatchObject({ phase: 'waiting', accepted: true }));
  observe(step);
}
beforeEach(async () => {
  await i18n.changeLanguage('en');
  useSession.getState().setSession(fixtureSession());
  useConnection.getState().setState('connected');
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); useSession.getState().setSession(null); useLoginSteps.getState().clearAll(); useConnection.getState().setState('disconnected'); });

it('clears the secret and does not allow a login event to replay an uncertain submit', async () => {
  const f = vi.fn(async (url: string) => url.endsWith('/submit') ? response({ error: { code: 'TIMEOUT_UNKNOWN' } }, 504) : response({ data: {} }));
  vi.stubGlobal('fetch', f);
  show();
  await start('password');
  const input = screen.getByLabelText('Two-step password');
  fireEvent.change(input, { target: { value: 'synthetic-test-secret' } });
  fireEvent.click(screen.getByRole('button', { name: 'Submit' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Submission outcome is unknown');
  expect(input).toHaveValue('');
  observe();
  expect(screen.queryByLabelText('Verification code')).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Submit' })).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Sign in' })).toBeDisabled();
  expect(f.mock.calls.map(c => c[0])).toEqual(['/api/channels/telegram/login', '/api/channels/telegram/login/submit']);
});

it('disables unavailable actions even when capability information is absent', () => {
  show({ ...channel, capabilities: undefined });
  expect(screen.getByRole('button', { name: 'Sign in' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Generate pairing code' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Mark voice verified' })).toBeDisabled();
  expect(screen.getByText('Pairing and voice verification are not available yet.')).toBeInTheDocument();
});

it('opens a prompt only after the local start is accepted and sends an explicit value once', async () => {
  let accepted!: (result: Response) => void;
  const f = vi.fn((...args: [string, RequestInit?]) => args[0].endsWith('/submit') ? Promise.resolve(response({ data: {} })) : new Promise<Response>(resolve => { accepted = resolve; }));
  vi.stubGlobal('fetch', f);
  show();
  fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
  observe();
  expect(screen.queryByLabelText('Verification code')).not.toBeInTheDocument();
  await act(async () => { accepted(response({ data: {} })); });
  fireEvent.change(await screen.findByLabelText('Verification code'), { target: { value: 'fixture-code' } });
  fireEvent.click(screen.getByRole('button', { name: 'Submit' }));
  await waitFor(() => expect(useLoginSteps.getState().steps.telegram).toBeUndefined());
  expect(f.mock.calls.map(c => c[0])).toEqual(['/api/channels/telegram/login', '/api/channels/telegram/login/submit']);
  expect(JSON.parse(String(f.mock.calls[1][1]?.body))).toEqual({ challengeId: firstId, step: 'code', value: 'fixture-code' });
});

it('drops credentials and blocks standalone events after a disconnect', async () => {
  const f = vi.fn(async () => response({ data: {} }));
  vi.stubGlobal('fetch', f);
  show();
  await start();
  fireEvent.change(screen.getByLabelText('Verification code'), { target: { value: 'old-fixture-code' } });
  act(() => { useLoginSteps.getState().interrupted(); useConnection.getState().setState('disconnected'); });
  expect(screen.queryByLabelText('Verification code')).not.toBeInTheDocument();
  act(() => useConnection.getState().setState('connected'));
  observe('password');
  expect(screen.queryByLabelText('Two-step password')).not.toBeInTheDocument();
  expect(screen.getByText(/The current login step is not available/i)).toBeInTheDocument();
  expect(f).toHaveBeenCalledTimes(1);
});

it('reports an unavailable prompt when a fetched account is already signing in', () => {
  const f = vi.fn();
  vi.stubGlobal('fetch', f);
  show({ ...channel, state: 'login_pending' });
  observe();
  expect(screen.getByRole('button', { name: 'Sign in' })).toBeDisabled();
  expect(screen.queryByLabelText('Verification code')).not.toBeInTheDocument();
  expect(screen.getByText(/The current login step is not available/i)).toBeInTheDocument();
  expect(f).not.toHaveBeenCalled();
});

it('reads the exact current step with no-store and never POSTs until a new explicit submit', async () => {
  const fetcher = mockReads(() => response({ data: stepFixture(firstId) }));
  show({ ...channel, state: 'login_pending' });
  const button = screen.getByRole('button', { name: 'Read current login step' });
  fireEvent.click(button);
  const input = await screen.findByLabelText('Verification code');
  expect(input).toHaveValue('');
  expect(fetcher.mock.calls).toHaveLength(1);
  const [path, options] = fetcher.mock.calls[0];
  expect(path).toBe(stepUrl);
  expect(options).toMatchObject({ method: 'GET', cache: 'no-store', body: undefined });
  expect(new Headers(options?.headers).get('Authorization')).toBe('Bearer fixture-admin');
  expect(path).not.toContain(firstId);
  fireEvent.change(input, { target: { value: 'fixture-fresh-code' } });
  fireEvent.click(screen.getByRole('button', { name: 'Submit' }));
  await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
  const [submitPath, submitOptions] = fetcher.mock.calls[1];
  expect(submitPath).toBe('/api/channels/telegram/login/submit');
  expect(submitOptions?.method).toBe('POST');
  expect(JSON.parse(String(submitOptions?.body))).toEqual({ challengeId: firstId, step: 'code', value: 'fixture-fresh-code' });
  expect(input).toHaveValue('');
});

it('can read back after a known start ACK without waiting for a WebSocket prompt', async () => {
  const fetcher = mockReads(() => response({ data: stepFixture(firstId, 'password') }));
  show();
  fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
  await waitFor(() => expect(useLoginSteps.getState().progress.telegram).toMatchObject({ phase: 'waiting', accepted: true }));
  fireEvent.click(screen.getByRole('button', { name: 'Read current login step' }));
  expect(await screen.findByLabelText('Two-step password')).toHaveValue('');
  expect(fetcher.mock.calls.map(([url, init]) => [url, init?.method])).toEqual([['/api/channels/telegram/login','POST'],[stepUrl,'GET']]);
});

it('drops an older value when a same-named challenge replaces the displayed form', async () => {
  const fetcher = mockReads(() => response({ data: stepFixture(secondId) }));
  show(); await start();
  fireEvent.change(screen.getByLabelText('Verification code'), { target: { value: 'old-fixture-code' } });
  observe('code', secondId);
  expect(screen.queryByLabelText('Verification code')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Read current login step' }));
  const input = await screen.findByLabelText('Verification code');
  expect(input).toHaveValue('');
  expect(useLoginSteps.getState().steps.telegram?.challengeId).toBe(secondId);
  expect(fetcher.mock.calls.map(([url, options]) => [url, options?.method])).toEqual([['/api/channels/telegram/login','POST'],[stepUrl,'GET']]);
});

it('ignores a duplicate notification for the same challenge and does not clear entered data', async () => {
  const fetcher = mockReads(() => response({ data: null }));
  show(); await start();
  const input = screen.getByLabelText('Verification code');
  fireEvent.change(input, { target: { value: 'fixture-current-code' } });
  observe();
  expect(input).toHaveValue('fixture-current-code');
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it.each(['disconnect','session replacement','unmount'] as const)('fences a delayed readback on %s', async boundary => {
  let reply!:(r:Response)=>void;
  const fetcher=mockReads(() => new Promise(resolve=>{reply=resolve;}));
  const view=show({ ...channel, state: 'login_pending' });
  fireEvent.click(screen.getByRole('button', { name: 'Read current login step' }));
  expect(fetcher).toHaveBeenCalledOnce();
  const signal=fetcher.mock.calls[0]?.[1]?.signal;
  if(boundary==='disconnect') {
    act(() => { useLoginSteps.getState().interrupted(); useConnection.getState().setState('disconnected'); });
    act(() => useConnection.getState().setState('connected'));
  } else if(boundary==='session replacement') {
    act(() => useSession.getState().setSession(fixtureSession('different-offline-session')));
  } else view.unmount();
  expect(signal?.aborted).toBe(true);
  await act(async () => { reply(response({ data: stepFixture(firstId) })); });
  expect(screen.queryByLabelText('Verification code')).not.toBeInTheDocument();
  expect(useLoginSteps.getState().steps.telegram).toBeUndefined();
  expect(fetcher).toHaveBeenCalledOnce();
});

it('drops a late read from before a newer socket observation, even if still connected', async () => {
  let reply!:(r:Response)=>void;
  const fetcher=mockReads(() => new Promise(resolve=>{reply=resolve;}));
  show({ ...channel, state: 'login_pending' });
  fireEvent.click(screen.getByRole('button', { name: 'Read current login step' }));
  observe('code', secondId);
  await act(async () => { reply(response({ data: stepFixture(firstId) })); });
  expect(screen.queryByLabelText('Verification code')).not.toBeInTheDocument();
  expect(useLoginSteps.getState().steps.telegram).toBeUndefined();
  expect(fetcher).toHaveBeenCalledOnce();
});

it.each([['null',null],['malformed',{step:'code',qrPngBase64:null,hint:null}],['invalid ID',{...stepFixture(firstId),challengeId:firstId+'\n'}]] as const)('does not open a form from a %s response', async (_kind,result) => {
  const fetcher=mockReads(() => response({ data: result }));
  show({ ...channel, state: 'login_pending' });
  fireEvent.click(screen.getByRole('button', { name: 'Read current login step' }));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Read current login step' })).toBeEnabled());
  expect(screen.queryByLabelText('Verification code')).not.toBeInTheDocument();
  expect(fetcher).toHaveBeenCalledOnce();
});

it('aborts a stalled read at the deadline and does not apply a later response', async () => {
  let reply!: (r: Response) => void;
  const fetcher = mockReads(() => new Promise(resolve => { reply = resolve; }));
  show({ ...channel, state: 'login_pending' });
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  try {
    const trigger = screen.getByRole('button', { name: 'Read current login step' });
    fireEvent.click(trigger);
    const signal = fetcher.mock.calls[0]?.[1]?.signal;
    await act(async () => { await vi.advanceTimersByTimeAsync(9_999); });
    expect(signal?.aborted).toBe(false);
    expect(trigger).toBeDisabled();
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(signal?.aborted).toBe(true);
    expect(trigger).toBeEnabled();
    expect(screen.getByRole('alert')).toHaveTextContent('Could not read the current login step');
    await act(async () => { reply(response({ data: stepFixture(firstId) })); });
    expect(screen.queryByLabelText('Verification code')).not.toBeInTheDocument();
    expect(fetcher.mock.calls.map(([, init]) => init?.method)).toEqual(['GET']);
  } finally { vi.useRealTimers(); }
});

it('retires a rejected challenge without replaying the value when a later read opens a different challenge', async () => {
  const fetcher = vi.fn(async (...args: [string, RequestInit?]) => args[0].endsWith('/submit') ?
    response({ error: { code: 'BAD_MESSAGE' } }, 400) : args[0] === stepUrl ?
    response({ data: stepFixture(secondId) }) : response({ data: {} }));
  vi.stubGlobal('fetch', fetcher);
  show(); await start();
  fireEvent.change(screen.getByLabelText('Verification code'), { target: { value: 'fixture-stale-code' } });
  fireEvent.click(screen.getByRole('button', { name: 'Submit' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('BAD_MESSAGE');
  expect(screen.queryByLabelText('Verification code')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Read current login step' }));
  expect(await screen.findByLabelText('Verification code')).toHaveValue('');
  expect(useLoginSteps.getState().steps.telegram?.challengeId).toBe(secondId);
  expect(fetcher.mock.calls.map(([, init]) => init?.method)).toEqual(['POST', 'POST', 'GET']);
});

it('cannot revive an unknown submission from a terminal account hint or a standalone prompt', async () => {
  const fetcher = mockReads(() => response({ data: stepFixture(secondId) }), true);
  show(); await start();
  fireEvent.change(screen.getByLabelText('Verification code'), { target: { value: 'fixture-uncertain-code' } });
  fireEvent.click(screen.getByRole('button', { name: 'Submit' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Submission outcome is unknown');
  act(() => useLoginSteps.getState().finished('telegram'));
  observe('code',secondId);
  expect(screen.queryByRole('button', { name: 'Read current login step' })).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Sign out' })).toBeDisabled();
  expect(screen.queryByLabelText('Verification code')).not.toBeInTheDocument();
  expect(useLoginSteps.getState().progress.telegram?.phase).toBe('uncertain');
  expect(fetcher.mock.calls.map(([url])=>url)).toEqual(['/api/channels/telegram/login','/api/channels/telegram/login/submit']);
});
