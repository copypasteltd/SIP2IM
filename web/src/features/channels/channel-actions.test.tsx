import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AppProviders } from '../../app/providers';
import { ChannelActions } from './channel-actions';
import { useLoginSteps } from '../../realtime/login-steps';
import { useConnection } from '../../realtime/use-admin-socket';
import i18n from '../../i18n';
import type { Channel } from '../../api/management';

const channel: Channel = { platform: 'telegram', state: 'logged_out', alias: null, voiceVerified: false, isInbound: false, pairedUser: null, capabilities: { login: true, sendMessage: false, receiveMessage: false, dial: false, receiveAudio: false, sendAudio: false, maxConcurrentCalls: 0 } };
const response = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
const show = (value = channel) => render(<AppProviders><ChannelActions channel={value}/></AppProviders>);
const observe = (step: 'code' | 'password' = 'code') => act(() => useLoginSteps.getState().observeStep('telegram', { step, qrPngBase64: null, hint: null }));
async function start(step: 'code' | 'password' = 'code') {
  fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
  await waitFor(() => expect(useLoginSteps.getState().progress.telegram).toMatchObject({ phase: 'waiting', accepted: true }));
  observe(step);
}
beforeEach(async () => { await i18n.changeLanguage('en'); useConnection.getState().setState('connected'); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); useLoginSteps.getState().clearAll(); useConnection.getState().setState('disconnected'); });

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
  expect(screen.getByRole('button', { name: 'Submit' })).toBeDisabled();
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
  expect(JSON.parse(String(f.mock.calls[1][1]?.body))).toEqual({ step: 'code', value: 'fixture-code' });
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
