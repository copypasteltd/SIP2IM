import {cleanup,render,screen,within} from '@testing-library/react';
import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
import {MemoryRouter} from 'react-router-dom';
import {afterEach,expect,it,vi} from 'vitest';
import {DashboardActivity} from './dashboard-activity';
import i18n from '../../i18n';
afterEach(()=>{cleanup();vi.unstubAllGlobals();});
it('requests open alerts without unsupported parameters and displays at most five',async()=>{
  await i18n.changeLanguage('en');
  const alerts=Array.from({length:6},(_,i)=>({id:`alert${i}`,severity:'critical',type:'offline',subjectId:`device${i}`,lastAt:10000}));
  const fetchMock=vi.fn().mockImplementation((url:string)=>{
    if(url==='/api/calls?active=true&limit=50')return Promise.resolve(new Response(JSON.stringify({data:[],nextCursor:null}),{status:200}));
    if(url==='/api/alerts?state=open')return Promise.resolve(new Response(JSON.stringify({data:alerts,nextCursor:null}),{status:200}));
    return Promise.resolve(new Response('Unexpected URL',{status:400}));
  });
  vi.stubGlobal('fetch',fetchMock);
  const client=new QueryClient({defaultOptions:{queries:{retry:false}}});
  render(<QueryClientProvider client={client}><MemoryRouter><DashboardActivity stale={false}/></MemoryRouter></QueryClientProvider>);
  const section=(await screen.findByText(/device0/)).closest('section')!;
  expect(fetchMock).toHaveBeenCalledWith('/api/alerts?state=open',expect.anything());
  expect(within(section).getAllByRole('listitem')).toHaveLength(5);
  expect(within(section).getByText(/device4/)).toBeInTheDocument();
  expect(within(section).queryByText(/device5/)).not.toBeInTheDocument();
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
