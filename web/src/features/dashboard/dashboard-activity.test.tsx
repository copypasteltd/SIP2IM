import {cleanup,render,screen,within} from '@testing-library/react';
import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
import {MemoryRouter} from 'react-router-dom';
import {afterEach,expect,it,vi} from 'vitest';
import {DashboardActivity} from './dashboard-activity';
import i18n from '../../i18n';
afterEach(()=>{cleanup();vi.unstubAllGlobals();});
it('requests only five open alerts and does not follow the next cursor',async()=>{
  await i18n.changeLanguage('en');
  const alerts=Array.from({length:6},(_,i)=>({id:`alert${i}`,severity:'critical',type:'offline',subjectId:`device${i}`,lastAt:10000,state:'open'}));
  const fetchMock=vi.fn().mockImplementation((url:string)=>{
    if(url==='/api/calls?active=true&limit=50')return Promise.resolve(new Response(JSON.stringify({data:[],nextCursor:null}),{status:200}));
    if(url==='/api/alerts?limit=5&state=open')return Promise.resolve(new Response(JSON.stringify({data:alerts.slice(0,5),nextCursor:'more-open-alerts'}),{status:200}));
    return Promise.resolve(new Response('Unexpected URL',{status:400}));
  });
  vi.stubGlobal('fetch',fetchMock);
  const client=new QueryClient({defaultOptions:{queries:{retry:false}}});
  render(<QueryClientProvider client={client}><MemoryRouter><DashboardActivity stale={false}/></MemoryRouter></QueryClientProvider>);
  const section=(await screen.findByText(/device0/)).closest('section')!;
  expect(fetchMock.mock.calls.map(([url])=>url)).toEqual(['/api/calls?active=true&limit=50','/api/alerts?limit=5&state=open']);
  expect(within(section).getAllByRole('listitem')).toHaveLength(5);
  expect(within(section).getByText(/device4/)).toBeInTheDocument();
  expect(within(section).queryByText(/device5/)).not.toBeInTheDocument();
});

it('retains the five-row dashboard alert snapshot on a refresh error', async () => {
  await i18n.changeLanguage('en');
  let alertReads = 0;
  const fetchMock = vi.fn(async (url: string) => {
    if (url === '/api/calls?active=true&limit=50') return Response.json({ data: [], nextCursor: null });
    if (url !== '/api/alerts?limit=5&state=open') throw new Error('Unexpected fixture URL: ' + url);
    if (++alertReads > 1) return Response.json({ error: { code: 'FAILED' } }, { status: 500 });
    return Response.json({ data: [{
      id: 'alert1', type: 'channel_down', subjectId: 'telegram', severity: 'warning', state: 'open', lastAt: 1,
    }], nextCursor: null });
  });
  vi.stubGlobal('fetch', fetchMock);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><MemoryRouter><DashboardActivity stale={false}/></MemoryRouter></QueryClientProvider>);
  const row = (await screen.findByText(/Platform channel is unavailable/)).closest('li');
  await client.invalidateQueries({ queryKey: ['alerts'] });
  expect(await screen.findByRole('alert')).toHaveTextContent('Unable to load data');
  expect(row).toBeInTheDocument();
  expect(alertReads).toBe(2);
});
it('shows active legs and open alerts from separate endpoints',async()=>{await i18n.changeLanguage('en');vi.stubGlobal('fetch',vi.fn().mockImplementation((url:string)=>Promise.resolve(new Response(JSON.stringify({data:url.startsWith('/api/calls')?[{id:'call1',peer:'123',deviceId:'dev1',simId:'sim1',legs:[{id:'a',type:'cellular',state:'connected'},{id:'b',type:'platform',state:'ringing'}],promptPlayed:true,earlyMediaForwarded:false}]:[{id:'alert1',severity:'critical',type:'offline',subjectId:'dev1',lastAt:10000}],nextCursor:null}),{status:200}))));const client=new QueryClient({defaultOptions:{queries:{retry:false}}});render(<QueryClientProvider client={client}><MemoryRouter><DashboardActivity stale={false}/></MemoryRouter></QueryClientProvider>);expect(await screen.findByText('123')).toBeInTheDocument();expect(screen.getByText('Connected')).toBeInTheDocument();expect(screen.getByText('Ringing')).toBeInTheDocument();expect(await screen.findByText('critical')).toBeInTheDocument();});

it('labels rejecting and unknown rows as records with no confirmed bridge', async () => {
  await i18n.changeLanguage('en');
  const records = ['rejecting', 'unknown'].map(state => ({ id: state, state, peer: state + ' record', deviceId: 'fixture-device', simId: null, platform: null, legs: [{ id: 'cell', type: 'cellular', state: 'connected' }], promptPlayed: false, earlyMediaForwarded: false }));
  vi.stubGlobal('fetch', vi.fn(async (url: string) => new Response(JSON.stringify({ data: url.startsWith('/api/calls?') ? records : url.startsWith('/api/alerts?') ? [] : { name: 'Fixture device', sims: [] }, nextCursor: null }), { status: 200 })));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><MemoryRouter><DashboardActivity stale={false}/></MemoryRouter></QueryClientProvider>);
  expect(await screen.findByRole('heading', { name: 'Non-ended call records' })).toBeInTheDocument();
  await screen.findByRole('link', { name: 'rejecting record' });
  expect(screen.getAllByText('Bridge not confirmed.')).toHaveLength(2);
  expect(screen.getByRole('link', { name: 'rejecting record' }).closest('article')?.querySelector('svg')).toBeNull();
});
