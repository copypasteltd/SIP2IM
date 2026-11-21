import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import i18n from '../../i18n';
import { useConnection } from '../../realtime/use-admin-socket';
import { DeviceList } from './devices';

const response = (cursor: string | null = null) => new Response(JSON.stringify({ data: [{ id: 'one', name: 'Gateway', online: true, lastSeenAt: Date.now(), capabilityLevel: 'L2', sims: [{ id: 'sim', slot: 0, number: '123', carrier: 'Carrier', state: 'ready', lastSeenAt: Date.now(), needsReview: false }] }], nextCursor: cursor }), { status: 200 });
const failure = () => new Response(JSON.stringify({ error: { code: 'INTERNAL' } }), { status: 500 });
const setup = () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><MemoryRouter><DeviceList /></MemoryRouter></QueryClientProvider>);
  return client;
};
afterEach(() => { cleanup(); vi.unstubAllGlobals(); useConnection.getState().setState('disconnected'); });

it('keeps cached details but marks both states unknown after a failed background refresh and restores them after retry', async () => {
  await i18n.changeLanguage('en');
  useConnection.getState().setState('connected');
  const fetchMock = vi.fn().mockImplementationOnce(() => Promise.resolve(response('next'))).mockImplementationOnce(() => Promise.resolve(failure())).mockImplementationOnce(() => Promise.resolve(response('next')));
  vi.stubGlobal('fetch', fetchMock);
  const client = setup();
  const card = (await screen.findByRole('heading', { name: 'Gateway' })).closest('article')!;
  expect(within(card).getByText('Online')).toBeInTheDocument();
  expect(within(card).getByText('Ready')).toBeInTheDocument();
  await act(async () => { await client.invalidateQueries({ queryKey: ['devices'] }); });
  expect(await screen.findByRole('alert')).toHaveTextContent('Device refresh failed');
  expect(within(card).getByText('123')).toBeInTheDocument();
  expect(within(card).getByRole('listitem')).toHaveTextContent('Carrier');
  expect(within(card).getAllByText('Unknown')).toHaveLength(2);
  expect(within(card).queryByText('Online')).not.toBeInTheDocument();
  expect(within(card).queryByText('Ready')).not.toBeInTheDocument();
  const loadMore = screen.getByRole('button', { name: 'Load more' });
  expect(loadMore).toBeDisabled();
  fireEvent.click(loadMore);
  expect(fetchMock).toHaveBeenCalledTimes(2);
  fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
  expect(await within(card).findByText('Online')).toBeInTheDocument();
  expect(within(card).getByText('Ready')).toBeInTheDocument();
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});

it('shows unknown again when returning to a filter whose refresh fails', async () => {
  await i18n.changeLanguage('en');
  useConnection.getState().setState('connected');
  const fetchMock = vi.fn().mockImplementationOnce(() => Promise.resolve(response())).mockImplementationOnce(() => Promise.resolve(failure())).mockImplementationOnce(() => Promise.resolve(response())).mockImplementationOnce(() => Promise.resolve(failure())).mockImplementationOnce(() => Promise.resolve(failure()));
  vi.stubGlobal('fetch', fetchMock);
  const client = setup();
  await screen.findByRole('heading', { name: 'Gateway' });
  await act(async () => { await client.invalidateQueries({ queryKey: ['devices'] }); });
  expect(await screen.findByRole('alert')).toHaveTextContent('Device refresh failed');
  fireEvent.change(screen.getByLabelText('Connection status'), { target: { value: 'false' } });
  expect(await screen.findByText('Online')).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText('Connection status'), { target: { value: 'all' } });
  expect(await screen.findByRole('alert')).toHaveTextContent('Device refresh failed');
  await act(async () => { await client.invalidateQueries({ queryKey: ['devices'] }); });
  const card = screen.getByRole('heading', { name: 'Gateway' }).closest('article')!;
  expect(within(card).getAllByText('Unknown')).toHaveLength(2);
  expect(within(card).queryByText('Ready')).not.toBeInTheDocument();
});

it('marks cached states unknown on a next-page error and retries that page', async () => {
  await i18n.changeLanguage('en');
  useConnection.getState().setState('connected');
  const fetchMock = vi.fn().mockImplementationOnce(() => Promise.resolve(response('next'))).mockImplementationOnce(() => Promise.resolve(failure())).mockImplementationOnce(() => Promise.resolve(new Response(JSON.stringify({ data: [], nextCursor: null }), { status: 200 })));
  vi.stubGlobal('fetch', fetchMock);
  setup();
  const card = (await screen.findByRole('heading', { name: 'Gateway' })).closest('article')!;
  fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Unable to load data');
  expect(within(card).getAllByText('Unknown')).toHaveLength(2);
  fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
  expect(await within(card).findByText('Online')).toBeInTheDocument();
  expect(within(card).getByText('Ready')).toBeInTheDocument();
  expect(String(fetchMock.mock.calls[2]?.[0])).toContain('cursor=next');
});
