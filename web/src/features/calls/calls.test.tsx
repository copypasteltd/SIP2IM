import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import i18n from '../../i18n';
import { useConnection } from '../../realtime/use-admin-socket';
import { Calls } from './calls';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); useConnection.getState().setState('disconnected'); });

it('keeps reported statuses visible while preventing unsupported hangup', async () => {
  await i18n.changeLanguage('en');
  const calls = [
    { id: 'active', peer: 'Alice', state: 'active', platform: 'telegram', startedAt: 1700000000000, endedAt: null, endCause: null },
    { id: 'ended', peer: 'Bob', state: 'ended', platform: 'qq', startedAt: 1700000000000, endedAt: 1700000001000, endCause: 'remote' },
    { id: 'unknown', peer: 'Carol', state: 'unknown', platform: null, startedAt: 1700000000000, endedAt: null, endCause: null },
  ];
  const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: calls, nextCursor: null }), { status: 200 }));
  vi.stubGlobal('fetch', fetchMock);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><MemoryRouter><Calls /></MemoryRouter></QueryClientProvider>);
  const active = (await screen.findByRole('link', { name: 'Alice' })).closest('article')!;
  const ended = screen.getByRole('link', { name: 'Bob' }).closest('article')!;
  expect(within(active).getByText(/Call status: active/)).toBeInTheDocument();
  expect(within(ended).getByText(/Call status: ended/)).toBeInTheDocument();
  expect(within(ended).getByText(/qq · remote/)).toBeInTheDocument();
  const button = within(active).getByRole('button', { name: 'Hang up' });
  expect(button).toHaveAttribute('aria-disabled', 'true');
  button.focus();
  expect(button).toHaveFocus();
  fireEvent.keyDown(button, { key: 'Enter' });
  fireEvent.keyUp(button, { key: 'Enter' });
  fireEvent.keyDown(button, { key: ' ' });
  fireEvent.keyUp(button, { key: ' ' });
  expect(button).toHaveAccessibleDescription('Hangup is available in the dialer for its current call. This record is read-only.');
  expect(within(ended).queryByRole('button', { name: 'Hang up' })).not.toBeInTheDocument();
  const unknown = screen.getByRole('link', { name: 'Carol' });
  expect(unknown).toHaveAttribute('href', '/calls/unknown');
  expect(within(unknown.closest('article')!).getByText(/Call status: unknown/)).toBeInTheDocument();
  expect(within(unknown.closest('article')!).getByRole('button', { name: 'Hang up' })).toHaveAttribute('aria-disabled', 'true');
  fireEvent.click(button);
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(fetchMock.mock.calls[0][0]).toBe('/api/calls?limit=50');
});

it.each([['zh-CN', '请在拨号界面挂断该界面中的当前通话。此记录为只读。'], ['zh-HK', '請在撥號介面掛斷該介面中的目前通話。此紀錄為唯讀。']])('explains unavailable hangup in %s', async (language, explanation) => {
  await i18n.changeLanguage(language);
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: [], nextCursor: null }), { status: 200 })));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><MemoryRouter><Calls /></MemoryRouter></QueryClientProvider>);
  expect(screen.getByText(explanation)).toBeInTheDocument();
  await screen.findByText(i18n.t('empty'));
});

it('retains loaded calls on a next-page failure and retries the same cursor', async () => {
  await i18n.changeLanguage('en');
  const call = (id: string, peer: string) => ({ id, peer, state: 'active', platform: 'telegram', startedAt: 1700000000000, endedAt: null, endCause: null });
  const fetchMock = vi.fn()
    .mockResolvedValueOnce(new Response(JSON.stringify({ data: [call('one', 'Alice')], nextCursor: 'next' }), { status: 200 }))
    .mockResolvedValueOnce(new Response(JSON.stringify({ error: { code: 'FAILED' } }), { status: 500 }))
    .mockResolvedValueOnce(new Response(JSON.stringify({ data: [call('two', 'Bob')], nextCursor: null }), { status: 200 }));
  vi.stubGlobal('fetch', fetchMock);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><MemoryRouter><Calls /></MemoryRouter></QueryClientProvider>);
  await screen.findByRole('link', { name: 'Alice' });
  fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
  expect(await screen.findByRole('alert')).toHaveTextContent(i18n.t('loadError'));
  expect(screen.getByRole('link', { name: 'Alice' })).toBeInTheDocument();
  expect(screen.queryByText(i18n.t('empty'))).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Hang up' })).toHaveAccessibleDescription(i18n.t('action.hangupUnavailable'));
  fireEvent.click(screen.getByRole('button', { name: 'Retry loading more calls' }));
  expect(await screen.findByRole('link', { name: 'Bob' })).toBeInTheDocument();
  expect(screen.getByRole('link', { name: 'Alice' })).toBeInTheDocument();
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  expect(fetchMock.mock.calls.map(call => call[0])).toEqual(['/api/calls?limit=50', '/api/calls?limit=50&cursor=next', '/api/calls?limit=50&cursor=next']);
});

it.each([['en', 'Retry loading more calls'], ['zh-CN', '重试加载更多通话'], ['zh-HK', '重試載入更多通話']])('does not show an empty list when the next page fails in %s', async (language, retryLabel) => {
  await i18n.changeLanguage(language);
  vi.stubGlobal('fetch', vi.fn()
    .mockResolvedValueOnce(new Response(JSON.stringify({ data: [], nextCursor: 'next' }), { status: 200 }))
    .mockResolvedValueOnce(new Response(JSON.stringify({ error: { code: 'FAILED' } }), { status: 500 })));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><MemoryRouter><Calls /></MemoryRouter></QueryClientProvider>);
  fireEvent.click(await screen.findByRole('button', { name: i18n.t('loadMore') }));
  expect(await screen.findByRole('alert')).toHaveTextContent(i18n.t('loadError'));
  expect(screen.queryByText(i18n.t('empty'))).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: retryLabel })).toBeEnabled();
});


it('retries a failed background refresh while retaining cached calls', async () => {
  await i18n.changeLanguage('en');
  const call = { id: 'one', peer: 'Alice', state: 'active', platform: 'telegram', startedAt: 1700000000000, endedAt: null, endCause: null };
  const fetchMock = vi.fn()
    .mockResolvedValueOnce(new Response(JSON.stringify({ data: [call], nextCursor: null }), { status: 200 }))
    .mockResolvedValueOnce(new Response(JSON.stringify({ error: { code: 'FAILED' } }), { status: 500 }))
    .mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ ...call, peer: 'Updated Alice' }], nextCursor: null }), { status: 200 }));
  vi.stubGlobal('fetch', fetchMock);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><MemoryRouter><Calls /></MemoryRouter></QueryClientProvider>);
  await screen.findByRole('link', { name: 'Alice' });
  void client.invalidateQueries({ queryKey: ['calls'] });
  expect(await screen.findByRole('alert')).toHaveTextContent(i18n.t('callSnapshot.failed'));
  expect(screen.getByRole('alert')).toHaveTextContent(i18n.t('loadError'));
  expect(screen.getByRole('link', { name: 'Alice' })).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
  expect(await screen.findByRole('link', { name: 'Updated Alice' })).toBeInTheDocument();
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});

it('shows the initial failure without a false empty state', async () => {
  await i18n.changeLanguage('en');
  vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ error: { code: 'FAILED' } }), { status: 500 })).mockResolvedValueOnce(new Response(JSON.stringify({ data: [], nextCursor: null }), { status: 200 })));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><MemoryRouter><Calls /></MemoryRouter></QueryClientProvider>);
  expect(await screen.findByRole('alert')).toHaveTextContent(i18n.t('loadError'));
  expect(screen.queryByText(i18n.t('empty'))).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
  expect(await screen.findByText(i18n.t('empty'))).toBeInTheDocument();
});

it('shows page snapshot context and refreshes loaded pages manually', async () => {
  await i18n.changeLanguage('en'); useConnection.getState().setState('connected');
  const call = (peer: string) => ({id:peer,peer,state:'active',platform:null,startedAt:1700000000000,endedAt:null,endCause:null});
  let version = 0;
  const fetchMock = vi.fn((url: string) => Promise.resolve(new Response(JSON.stringify(url.includes('cursor=') ? {data:[call('Bob')],nextCursor:null} : {data:[call(version++ ? 'Updated Alice' : 'Alice')],nextCursor:'next'}),{status:200})));
  vi.stubGlobal('fetch',fetchMock);
  const client = new QueryClient({defaultOptions:{queries:{retry:false}}});
  render(<QueryClientProvider client={client}><MemoryRouter><Calls/></MemoryRouter></QueryClientProvider>);
  await screen.findByRole('link',{name:'Alice'});
  expect(screen.getByText(/Last successful list request/).querySelector('time')).toHaveAttribute('datetime');
  expect(screen.getByText(/List pages can reflect different times/)).toBeInTheDocument();
  expect(screen.queryByText(/Connection not established/)).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button',{name:'Load more'})); await screen.findByRole('link',{name:'Bob'});
  useConnection.getState().setState('disconnected'); expect(await screen.findByText(/Connection not established/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button',{name:'Refresh calls'})); await screen.findByRole('link',{name:'Updated Alice'});
  expect(screen.getByRole('link',{name:'Bob'})).toBeInTheDocument();
  expect(fetchMock.mock.calls.map(c=>c[0])).toEqual(['/api/calls?limit=50','/api/calls?limit=50&cursor=next','/api/calls?limit=50','/api/calls?limit=50&cursor=next']);
});
