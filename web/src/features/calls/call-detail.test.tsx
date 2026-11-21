import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Link, MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import i18n from '../../i18n';
import { useConnection } from '../../realtime/use-admin-socket';
import { CallDetailPage } from './call-detail';

afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); useConnection.getState().setState('disconnected'); });
const response = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
async function setup(fetchMock: ReturnType<typeof vi.fn>) {
  await i18n.changeLanguage('en'); vi.stubGlobal('fetch', fetchMock);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><MemoryRouter initialEntries={['/calls/test']}><Routes><Route path="/calls/:sessionId" element={<CallDetailPage/>}/></Routes></MemoryRouter></QueryClientProvider>);
  return client;
}
it('keeps pages on failure, retries the same cursor, deduplicates, and refreshes from the start', async () => {
  let nextAttempts = 0; let first = 0;
  const fetchMock = vi.fn((url: string) => {
    if (url.endsWith('/summary')) return Promise.resolve(response({data:{peer:'Alice',state:'active',legs:[]}}));
    const cursor = new URL(url, 'http://localhost').searchParams.get('cursor');
    if (cursor) { nextAttempts++; return Promise.resolve(nextAttempts === 1 ? response({error:{code:'EVENT_TOO_LARGE'}},422) : response({data:[{id:'1',event:'First event',ts:1},{id:'2',event:'Second event',ts:2}],nextCursor:null})); }
    first++; return Promise.resolve(response({data:[{id:first===1?'1':'3',event:first===1?'First event':'Fresh event',ts:1}],nextCursor:'next+cursor'}));
  });
  const client = await setup(fetchMock); await screen.findByText(/First event/); expect(screen.getByText(/Events can change while you browse/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button',{name:'Load more'})); await screen.findByText(/An event is too large/); expect(screen.getByText(/First event/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button',{name:'Retry loading more'})); await screen.findByText(/Second event/); expect(screen.getAllByText(/First event/)).toHaveLength(1);
  const urls = fetchMock.mock.calls.map(call => String(call[0])); expect(urls.filter(url=>url.includes('cursor=next%2Bcursor'))).toHaveLength(2); expect(urls).toContain('/api/calls/test/events?limit=50'); expect(urls).not.toContain('/api/calls/test');
  await client.invalidateQueries(); expect(first).toBe(1); expect(screen.getByText(/Second event/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button',{name:'Refresh events'})); await screen.findByText(/Fresh event/); expect(screen.queryByText(/Second event/)).not.toBeInTheDocument();
});
it('preserves existing events on a server error and sends a long cursor intact', async () => {
  const cursor = 'x'.repeat(8192); let attempts = 0;
  const fetchMock = vi.fn((url: string) => {
    if (url.endsWith('/summary')) return Promise.resolve(response({data:{peer:'Alice',state:'active',legs:[]}}));
    const pageCursor = new URL(url, 'http://localhost').searchParams.get('cursor');
    if (!pageCursor) return Promise.resolve(response({data:[{id:'1',event:'Saved event',ts:1}],nextCursor:cursor}));
    expect(pageCursor).toBe(cursor); attempts++;
    return Promise.resolve(attempts === 1 ? response({error:{code:'INTERNAL'}},500) : response({data:[{id:'2',event:'Next event',ts:2}],nextCursor:null}));
  });
  await setup(fetchMock); await screen.findByText(/Saved event/);
  fireEvent.click(screen.getByRole('button',{name:'Load more'})); await screen.findByRole('alert');
  expect(screen.getByText(/Saved event/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button',{name:'Retry loading more'})); await screen.findByText(/Next event/); expect(attempts).toBe(2);
});
it.each([404,405])('shows ambiguity on %s without falling back', async status => {
  const fetchMock = vi.fn((url: string) => Promise.resolve(response({error:{code:url ? 'NOT_FOUND' : 'UNKNOWN'}},status))); await setup(fetchMock);
  await waitFor(() => expect(screen.getAllByText(/may not exist/)).toHaveLength(2));
  expect(fetchMock.mock.calls.map(call=>String(call[0]))).toEqual(expect.arrayContaining(['/api/calls/test/summary','/api/calls/test/events?limit=50']));
  expect(fetchMock.mock.calls.some(call=>String(call[0])==='/api/calls/test')).toBe(false);
});

it('starts fresh on remount after refresh and ignores an old delayed response', async () => {
  await i18n.changeLanguage('en');
  let resolveOld!: (value: Response) => void;
  let firstRequests = 0;
  const fetchMock = vi.fn((url: string) => {
    if (url.endsWith('/summary')) return Promise.resolve(response({data:{peer:'Alice',state:'active',legs:[]}}));
    const cursor = new URL(url, 'http://localhost').searchParams.get('cursor');
    if (cursor) return Promise.resolve(response({data:[{id:'2',event:'Old second page',ts:2}],nextCursor:null}));
    firstRequests++;
    if (firstRequests === 2) return new Promise<Response>(resolve => { resolveOld = resolve; });
    return Promise.resolve(response({data:[{id:String(firstRequests),event:firstRequests === 1 ? 'Old first page' : 'Remount first page',ts:1}],nextCursor:firstRequests === 1 ? 'next' : null}));
  });
  vi.stubGlobal('fetch', fetchMock);
  const client = new QueryClient({defaultOptions:{queries:{retry:false}}});
  render(<QueryClientProvider client={client}><MemoryRouter initialEntries={['/calls/test']}><Routes>
    <Route path="/calls/:sessionId" element={<CallDetailPage/>}/><Route path="/calls" element={<Link to="/calls/test">Return to call</Link>}/>
  </Routes></MemoryRouter></QueryClientProvider>);
  await screen.findByText(/Old first page/);
  fireEvent.click(screen.getByRole('button',{name:'Load more'})); await screen.findByText(/Old second page/);
  fireEvent.click(screen.getByRole('button',{name:'Refresh events'}));
  await waitFor(() => expect(firstRequests).toBe(2));
  expect(screen.getByText(/Old second page/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole('link',{name:/Calls/i}));
  fireEvent.click(screen.getByRole('link',{name:'Return to call'}));
  await screen.findByText(/Remount first page/);
  expect(screen.queryByText(/Old first page|Old second page/)).not.toBeInTheDocument();
  await act(async () => { resolveOld(response({data:[{id:'late',event:'Late old response',ts:3}],nextCursor:null})); });
  expect(screen.getByText(/Remount first page/)).toBeInTheDocument();
  expect(screen.queryByText(/Late old response/)).not.toBeInTheDocument();
  await waitFor(() => expect(client.getQueryCache().findAll({queryKey:['calls','test','events']})).toHaveLength(1));
  expect(firstRequests).toBe(3);
});

it('retains events and warns when refresh fails, then retries from the start', async () => {
  let requests = 0;
  const fetchMock = vi.fn((url: string) => {
    if (url.endsWith('/summary')) return Promise.resolve(response({data:{peer:'Alice',state:'active',legs:[]}}));
    requests++;
    return Promise.resolve(requests === 2 ? response({error:{code:'INTERNAL'}},500) : response({data:[{id:String(requests),event:requests === 1 ? 'Previous event' : 'Recovered event',ts:1}],nextCursor:null}));
  });
  await setup(fetchMock); await screen.findByText(/Previous event/);
  fireEvent.click(screen.getByRole('button',{name:'Refresh events'}));
  await screen.findByText(/refresh failed/i);
  expect(screen.getByText(/Previous event/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button',{name:'Try again'}));
  await screen.findByText(/Recovered event/);
  expect(screen.queryByText(/Previous event|refresh failed/i)).not.toBeInTheDocument();
  expect(requests).toBe(3);
});

it('warns when updating a cached summary fails', async () => {
  let summaries = 0;
  const fetchMock = vi.fn((url: string) => {
    if (url.endsWith('/summary')) return Promise.resolve(++summaries === 1 ? response({data:{peer:'Alice',state:'active',legs:[]}}) : response({error:{code:'INTERNAL'}},500));
    return Promise.resolve(response({data:[],nextCursor:null}));
  });
  const client = await setup(fetchMock); await screen.findByRole('heading',{name:'Alice'});
  await act(async () => { await client.invalidateQueries({queryKey:['calls','test','summary']}); });
  expect(screen.getByRole('heading',{name:'Alice'})).toBeInTheDocument();
  expect(await screen.findByText(/summary could not be updated/i)).toBeInTheDocument();
});

it('polls only the summary and keeps failed snapshots until manual recovery', async () => {
  useConnection.getState().setState('connected');
  let summaries = 0; let events = 0;
  const fetchMock = vi.fn((url: string) => {
    if (url.endsWith('/summary')) { summaries++; return Promise.resolve(summaries === 2 ? response({error:{code:'INTERNAL'}},500) : response({data:{peer:summaries === 1 ? 'Alice' : 'Updated Alice',state:'active',legs:[]}})); }
    events++; return Promise.resolve(response({data:[{id:'1',event:'Saved event',ts:1}],nextCursor:null}));
  });
  await i18n.changeLanguage('en'); vi.stubGlobal('fetch', fetchMock); vi.useFakeTimers();
  const client = new QueryClient({defaultOptions:{queries:{retry:false}}});
  render(<QueryClientProvider client={client}><MemoryRouter initialEntries={['/calls/test']}><Routes><Route path="/calls/:sessionId" element={<CallDetailPage/>}/></Routes></MemoryRouter></QueryClientProvider>);
  await act(async () => { await vi.advanceTimersByTimeAsync(20); });
  expect(screen.getByRole('heading',{name:'Alice'})).toBeInTheDocument(); expect(screen.getByText(/Saved event/)).toBeInTheDocument();
  const time = screen.getByText(/Last successful summary refresh/).querySelector('time')!; const originalTime = time.getAttribute('datetime');
  await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
  expect(summaries).toBe(2); expect(events).toBe(1);
  expect(screen.getByText(/summary could not be updated/i)).toBeInTheDocument();
  expect(screen.getByRole('heading',{name:'Alice'})).toBeInTheDocument(); expect(time).toHaveAttribute('datetime',originalTime);
  act(() => useConnection.getState().setState('disconnected')); expect(screen.getByText(/Connection not established/)).toBeInTheDocument();
  await act(async () => { fireEvent.click(screen.getByRole('button',{name:'Refresh summary'})); await vi.advanceTimersByTimeAsync(0); });
  expect(screen.getByRole('heading',{name:'Updated Alice'})).toBeInTheDocument();
  expect(screen.queryByText(/summary could not be updated/i)).not.toBeInTheDocument(); expect(events).toBe(1);
});
