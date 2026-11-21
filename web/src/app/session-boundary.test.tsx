import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AppProviders } from './providers';
import { AppRouter } from './router';
import { useSession } from '../stores/session';
import { request } from '../api/client';
import { useLoginSteps } from '../realtime/login-steps';
import i18n from '../i18n';

class Socket {
  static OPEN = 1;
  readyState = 1;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  close = vi.fn(() => this.onclose?.());
  send = vi.fn();
  constructor() { sockets.push(this); }
}
const sockets: Socket[] = [];
const response = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
const session = (token = 'synthetic-admin-token', expiresAt = Date.now() + 60_000) => ({ token, expiresAt, username: 'fixture' });
const route = () => render(<AppProviders><AppRouter/></AppProviders>);
beforeEach(async () => {
  useSession.getState().setSession(session());
  window.history.replaceState({}, '', '/devices');
  await i18n.changeLanguage('en');
  sockets.length = 0;
  vi.stubGlobal('WebSocket', Socket);
});
afterEach(() => {
  cleanup();
  useSession.getState().setSession(null);
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it.each([true, false])('uses the real console logout path, clears credentials and closes realtime (confirmed=%s)', async confirmed => {
  const fetchMock = vi.fn(async (url: string) => {
    if (url === '/api/auth/logout') {
      if (confirmed) return response({ data: {} });
      throw new TypeError('synthetic transport failure');
    }
    if (url === '/api/health') return response({ data: { adapters: { qq: 'online', telegram: 'unknown' } } });
    return response({ data: [], nextCursor: null });
  });
  vi.stubGlobal('fetch', fetchMock);
  route();
  await screen.findByText('Adapter reachable');
  expect(screen.getByText('Adapter reachability not observed')).toBeInTheDocument();
  useLoginSteps.getState().begin('telegram', { kind: 'start' });
  fireEvent.click(screen.getByRole('button', { name: 'Sign out of console' }));
  await screen.findByRole('heading', { name: 'Sign in' });
  const logout = fetchMock.mock.calls.filter(call => call[0] === '/api/auth/logout');
  expect(logout).toHaveLength(1);
  const init = (logout[0] as unknown as [string, RequestInit])[1];
  expect(init.method).toBe('POST');
  expect(new Headers(init.headers).get('Authorization')).toBe('Bearer synthetic-admin-token');
  expect(window.location.pathname).toBe('/login');
  expect(useSession.getState().session).toBeNull();
  expect(localStorage.getItem('voip.session')).toBeNull();
  expect(useLoginSteps.getState().progress.telegram).toBeUndefined();
  expect(sockets[0].close).toHaveBeenCalledOnce();
  expect(Boolean(screen.queryByText(/server could not confirm/i))).toBe(!confirmed);
});

it('does not let a retired request clear or repopulate a replacement session', async () => {
  let finishOld!: (response: Response) => void;
  let finishUnauthorized!: (response: Response) => void;
  const fetchMock = vi.fn((url: string, init?: RequestInit) => {
    if (url === '/api/health') return Promise.resolve(response({ data: {} }));
    if (url === '/api/auth/locale') return new Promise<Response>(resolve => { finishUnauthorized = resolve; });
    if (new Headers(init?.headers).get('Authorization') === 'Bearer synthetic-admin-token') return new Promise<Response>(resolve => { finishOld = resolve; });
    const device = { id: 'new-device', name: 'Replacement session device', online: false, lastSeenAt: null, capabilityLevel: null, sims: [] };
    return Promise.resolve(response({ data: [device], nextCursor: null }));
  });
  vi.stubGlobal('fetch', fetchMock);
  route();
  await waitFor(() => expect(finishOld).toBeDefined());
  const old401 = request('/api/auth/locale', { method: 'PUT', body: { locale: 'en' } }).catch(e => e);
  act(() => useSession.getState().setSession(session('replacement')));
  await screen.findByText('Replacement session device');
  await act(async () => {
    finishOld(response({ data: [{ id: 'old-device', name: 'Retired session device', sims: [] }], nextCursor: null }));
    finishUnauthorized(response({ error: { code: 'UNAUTHORIZED' } }, 401));
    expect(await old401).toMatchObject({ code: 'UNAUTHORIZED' });
  });
  expect(screen.queryByText('Retired session device')).not.toBeInTheDocument();
  expect(screen.getByText('Replacement session device')).toBeInTheDocument();
  expect(useSession.getState().session?.token).toBe('replacement');
});

it('does not delete a replacement credential before its storage event is delivered', async () => {
  let reply!: (value: Response) => void;
  vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(resolve => { reply = resolve; })));
  const old = request('/api/auth/logout', { method: 'POST' }).catch(error => error);
  const replacement = session('replacement-written-by-another-tab');
  localStorage.setItem('voip.session', JSON.stringify(replacement));
  reply(response({ error: { code: 'UNAUTHORIZED' } }, 401));
  expect(await old).toMatchObject({ status: 401 });
  expect(useSession.getState().session).toEqual(replacement);
  expect(localStorage.getItem('voip.session')).toBe(JSON.stringify(replacement));
});

it('expires a mounted session without a navigation or a rejected API response', async () => {
  vi.useFakeTimers();
  useSession.getState().setSession(session('expiring', Date.now() + 100));
  const fetchMock = vi.fn(async (url: string) => response({ data: url.startsWith('/api/devices') ? [] : {}, nextCursor: null }));
  vi.stubGlobal('fetch', fetchMock);
  route();
  await act(async () => { await vi.advanceTimersByTimeAsync(101); });
  expect(screen.getByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
  expect(localStorage.getItem('voip.session')).toBeNull();
  expect(sockets[0].close).toHaveBeenCalledOnce();
});
