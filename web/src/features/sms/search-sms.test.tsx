import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { SmsPage } from './sms';
import i18n from '../../i18n';
import { SearchSms } from './search-sms';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
it('searches exact peer and date range, paginates and resets filters', async () => {
  await i18n.changeLanguage('en');
  const fetchMock = vi.fn().mockImplementation((url: string) => {
    if (url.startsWith('/api/sms/history/devices')) return Promise.resolve(new Response(JSON.stringify({data:[{id:'dev',name:'Gateway',revoked:true}],nextCursor:null}),{status:200}));
    if (url.startsWith('/api/sms/history/sims')) return Promise.resolve(new Response(JSON.stringify({data:[{id:'sim1',deviceId:'dev',slot:0,number:'123',retired:true,deviceRevoked:true}],nextCursor:null}),{status:200}));
    const params = new URL(url, 'http://localhost').searchParams;
    return Promise.resolve(new Response(JSON.stringify({data:[{id:params.has('cursor')?'second':'first',direction:'in',deviceId:'dev',simId:'sim1',peer:'123',body:params.has('cursor')?'Older message':'Matching message',occurredAt:1700000000000,task:null}],nextCursor:params.has('cursor')?null:'next+page'}),{status:200}));
  });
  vi.stubGlobal('fetch', fetchMock);
  const client = new QueryClient({defaultOptions:{queries:{retry:false}}});
  render(<QueryClientProvider client={client}><SearchSms/></QueryClientProvider>);
  await screen.findByRole('option',{name:'Gateway · dev · Revoked device'});
  expect(await screen.findByRole('option',{name:/Retired SIM/})).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText('Device'),{target:{value:'dev'}});
  await screen.findByRole('option',{name:/Retired SIM/});
  fireEvent.change(screen.getByLabelText('SIM'),{target:{value:'sim1'}});
  fireEvent.change(screen.getByLabelText('Exact peer number'),{target:{value:' 123 '}});
  fireEvent.change(screen.getByLabelText('From date (local time)'),{target:{value:'2024-01-01'}});
  fireEvent.change(screen.getByLabelText('Through date (local time)'),{target:{value:'2024-01-02'}});
  fireEvent.click(screen.getByRole('button',{name:'Search'}));
  expect(await screen.findByText('Matching message')).toBeInTheDocument();
  expect(screen.getByText('Recorded attribution (SIM association is an ingestion-time estimate) · Device ID: dev · SIM ID: sim1')).toBeInTheDocument();
  const first = new URL(String(fetchMock.mock.calls.find(([url]) => String(url).startsWith('/api/sms?'))?.[0]),'http://localhost');
  expect(Object.fromEntries(first.searchParams)).toEqual({limit:'50',deviceId:'dev',simId:'sim1',peer:'123',from:String(new Date('2024-01-01T00:00:00').getTime()),toExclusive:String(new Date('2024-01-03T00:00:00').getTime())});
  fireEvent.click(screen.getByRole('button',{name:'Load more'}));
  expect(await screen.findByText('Older message')).toBeInTheDocument();
  expect(fetchMock.mock.calls.some(([url]) => String(url).includes('cursor=next%2Bpage'))).toBe(true);
  expect(screen.getByText('Live connection is down or refresh failed. Current status is unknown.')).toBeInTheDocument();
  const previousCalls = fetchMock.mock.calls.length;
  fireEvent.click(screen.getByRole('button',{name:'Search'}));
  await waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThan(previousCalls));
  expect(screen.queryByText('Older message')).not.toBeInTheDocument();
  const repeated = new URL(String(fetchMock.mock.calls.at(-1)?.[0]), 'http://localhost');
  expect(repeated.searchParams.has('cursor')).toBe(false);
  fireEvent.change(screen.getByLabelText('From date (local time)'),{target:{value:'1969-01-01'}});
  fireEvent.click(screen.getByRole('button',{name:'Search'}));
  expect(screen.getByRole('alert')).toHaveTextContent('Dates must be valid');
  expect(screen.queryByText('Matching message')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button',{name:'Clear search'}));
  expect(screen.queryByText('Matching message')).not.toBeInTheDocument();
  expect(screen.getByLabelText('Device')).toHaveValue('');
});
it('rejects an inverted date range without requesting messages', async () => {
  await i18n.changeLanguage('en');
  const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({data:[],nextCursor:null}),{status:200}));
  vi.stubGlobal('fetch',fetchMock);
  render(<QueryClientProvider client={new QueryClient({defaultOptions:{queries:{retry:false}}})}><SearchSms/></QueryClientProvider>);
  fireEvent.change(screen.getByLabelText('From date (local time)'),{target:{value:'2024-02-02'}});
  fireEvent.change(screen.getByLabelText('Through date (local time)'),{target:{value:'2024-02-01'}});
  fireEvent.click(screen.getByRole('button',{name:'Search'}));
  expect(screen.getByRole('alert')).toHaveTextContent('Dates must be valid');
  await waitFor(() => expect(fetchMock).toHaveBeenCalled());
  expect(fetchMock.mock.calls.some(([url]) => String(url).startsWith('/api/sms?'))).toBe(false);
});

it('keeps search usable when conversations fail', async () => {
  await i18n.changeLanguage('en');
  const fetchMock = vi.fn().mockImplementation((url:string) => Promise.resolve(url.startsWith('/api/sms/threads') ? new Response(JSON.stringify({error:{code:'INTERNAL'}}),{status:500}) : new Response(JSON.stringify({data:[],nextCursor:null}),{status:200})));
  vi.stubGlobal('fetch',fetchMock);
  render(<QueryClientProvider client={new QueryClient({defaultOptions:{queries:{retry:false}}})}><MemoryRouter><SmsPage/></MemoryRouter></QueryClientProvider>);
  expect(await screen.findByRole('alert')).toHaveTextContent('Unable to load');
  fireEvent.click(screen.getByRole('button',{name:'Search message history'}));
  fireEvent.click(screen.getByRole('button',{name:'Search'}));
  expect(await screen.findByText('No messages match these filters. Try changing the filters.')).toBeInTheDocument();
});
it('validates a skipped local day and uses the next calendar midnight', async () => {
  await i18n.changeLanguage('en');
  const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({data:[],nextCursor:null}),{status:200}));
  vi.stubGlobal('fetch',fetchMock);
  render(<QueryClientProvider client={new QueryClient({defaultOptions:{queries:{retry:false}}})}><SearchSms/></QueryClientProvider>);
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  if (zone === 'Pacific/Apia') {
    fireEvent.change(screen.getByLabelText('Through date (local time)'),{target:{value:'2011-12-30'}});
    fireEvent.click(screen.getByRole('button',{name:'Search'}));
    expect(screen.getByRole('alert')).toHaveTextContent('Dates must be valid');
    expect(fetchMock.mock.calls.some(([url]) => String(url).startsWith('/api/sms?'))).toBe(false);
  } else if (zone === 'America/Sao_Paulo') {
    fireEvent.change(screen.getByLabelText('Through date (local time)'),{target:{value:'2018-11-04'}});
    fireEvent.click(screen.getByRole('button',{name:'Search'}));
    await waitFor(() => expect(fetchMock.mock.calls.some(([url]) => String(url).startsWith('/api/sms?'))).toBe(true));
    const url = new URL(String(fetchMock.mock.calls.find(([u]) => String(u).startsWith('/api/sms?'))?.[0]),'http://localhost');
    expect(url.searchParams.get('toExclusive')).toBe(String(new Date('2018-11-05T00:00:00').getTime()));
  }
});

it('pages historical devices and SIMs and scopes SIM lookup to selected device', async () => {
  await i18n.changeLanguage('en');
  const mock = vi.fn().mockImplementation((url:string) => {
    const parsed = new URL(url,'http://localhost');
    if (parsed.pathname.endsWith('/devices')) return Promise.resolve(new Response(JSON.stringify({data:parsed.searchParams.has('cursor') ? [{id:'old',name:'Old gateway',revoked:true}] : [{id:'new',name:'Current',revoked:false}],nextCursor:parsed.searchParams.has('cursor')?null:'device+cursor'}),{status:200}));
    return Promise.resolve(new Response(JSON.stringify({data:parsed.searchParams.has('cursor') ? [{id:'oldsim',deviceId:'old',slot:0,number:null,retired:true,deviceRevoked:true}] : [],nextCursor:parsed.searchParams.has('cursor')?null:'sim+cursor'}),{status:200}));
  });
  vi.stubGlobal('fetch',mock);
  render(<QueryClientProvider client={new QueryClient({defaultOptions:{queries:{retry:false}}})}><SearchSms/></QueryClientProvider>);
  fireEvent.click(await screen.findByRole('button',{name:'Load more devices'}));
  expect(await screen.findByRole('option',{name:'Old gateway · old · Revoked device'})).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText('Device'),{target:{value:'old'}});
  await waitFor(()=>expect(mock.mock.calls.some(([url])=>String(url).includes('deviceId=old'))).toBe(true));
  fireEvent.click(await screen.findByRole('button',{name:'Load more SIMs'}));
  expect(await screen.findByRole('option',{name:/oldsim · Retired SIM · Revoked device/})).toBeInTheDocument();
  expect(mock.mock.calls.some(([url])=>String(url).includes('cursor=sim%2Bcursor') && String(url).includes('deviceId=old'))).toBe(true);
});
