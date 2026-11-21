import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import i18n from '../../i18n';
import { DeviceList } from './devices';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
it('filters devices on the server and resets pagination when filters change', async () => {
  await i18n.changeLanguage('en');
  const fetchMock = vi.fn().mockImplementation((url: string) => {
    const params = new URL(url, 'http://localhost').searchParams;
    const filtered = params.get('q') === 'Gate & one' && params.get('online') === 'false';
    const name = filtered ? 'Filtered gateway' : params.has('cursor') ? 'Second gateway' : 'First gateway';
    return Promise.resolve(new Response(JSON.stringify({ data: [{ id: filtered ? 'filtered' : params.has('cursor') ? 'second' : 'first', name, online: false, lastSeenAt: null, capabilityLevel: null, sims: [] }], nextCursor: !filtered && !params.has('cursor') ? 'next+page' : null }), { status: 200 }));
  });
  vi.stubGlobal('fetch', fetchMock);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><MemoryRouter><DeviceList /></MemoryRouter></QueryClientProvider>);
  expect(await screen.findByText('First gateway')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
  await waitFor(() => expect(fetchMock.mock.calls.some(([url]) => String(url).includes('cursor=next%2Bpage'))).toBe(true));
  fireEvent.change(screen.getByLabelText('Search devices'), { target: { value: ' Gate & one ' } });
  fireEvent.change(screen.getByLabelText('Connection status'), { target: { value: 'false' } });
  fireEvent.click(screen.getByRole('button', { name: 'Search' }));
  expect(await screen.findByText('Filtered gateway')).toBeInTheDocument();
  const url = new URL(String(fetchMock.mock.calls.at(-1)?.[0]), 'http://localhost');
  expect(url.searchParams.get('q')).toBe('Gate & one');
  expect(url.searchParams.get('online')).toBe('false');
  expect(url.searchParams.has('cursor')).toBe(false);
  expect(screen.queryByText('First gateway')).not.toBeInTheDocument();
});

it('keeps loaded devices visible when loading another page fails', async () => {
  await i18n.changeLanguage('en');
  const fetchMock = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ id: 'first', name: 'First gateway', online: false, lastSeenAt: null, capabilityLevel: null, sims: [] }], nextCursor: 'next' }), { status: 200 })).mockResolvedValueOnce(new Response(JSON.stringify({ error: { code: 'INTERNAL' } }), { status: 500 })).mockResolvedValueOnce(new Response(JSON.stringify({ data: [], nextCursor: null }), { status: 200 }));
  vi.stubGlobal('fetch', fetchMock);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><MemoryRouter><DeviceList /></MemoryRouter></QueryClientProvider>);
  fireEvent.click(await screen.findByRole('button', { name: 'Load more' }));
  expect(await screen.findByRole('alert')).toBeInTheDocument();
  expect(screen.getByText('First gateway')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
  await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
  expect(fetchMock).toHaveBeenCalledTimes(3);
});
