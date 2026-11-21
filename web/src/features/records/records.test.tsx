import {act,cleanup,fireEvent,render,screen,waitFor,within} from '@testing-library/react';
import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
import {Link,MemoryRouter,Route,Routes} from 'react-router-dom';
import {afterEach,expect,it,vi} from 'vitest';
import {RecordsPage} from './records';
import i18n from '../../i18n';
import {syncEvent} from '../../realtime/admin-socket';
afterEach(()=>{cleanup();vi.unstubAllGlobals();});
it('reads back a new health alert through polling when realtime delivery is absent',async()=>{
 await i18n.changeLanguage('en');
 vi.useFakeTimers();
 try {
  const response=vi.fn(async()=>new Response(JSON.stringify({data:response.mock.calls.length===1?[]:[{
   id:'alr-health',type:'sim_not_ready',state:'open',subjectId:'sim-fixture',severity:'warning',lastAt:100,
  }],nextCursor:null}),{status:200}));
  vi.stubGlobal('fetch',response);
  const client=new QueryClient({defaultOptions:{queries:{retry:false}}});
  render(<QueryClientProvider client={client}><RecordsPage kind="alerts"/></QueryClientProvider>);
  await act(async()=>{await vi.advanceTimersByTimeAsync(25);});
  expect(response).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole('heading',{name:'SIM is not ready'})).not.toBeInTheDocument();
  await act(async()=>{await vi.advanceTimersByTimeAsync(30_050);});
  expect(response).toHaveBeenCalledTimes(2);
  expect(screen.getByRole('heading',{name:'SIM is not ready'})).toBeInTheDocument();
 } finally { cleanup();vi.useRealTimers(); }
});

const alertsPath = '/api/alerts?limit=50';
const pageToken = 'opaque +/?=&';
const pageTwoPath = alertsPath + '&cursor=opaque+%2B%2F%3F%3D%26';
const pageThreePath = alertsPath + '&cursor=third';
const alertRows = (title: string, count = 1, state = 'open') => Array.from({ length: count }, (_, i) => ({
  id: title + i, type: title, subjectId: title + ' fixture ' + i, state, severity: 'warning', lastAt: 1,
}));
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const alertPage = (title: string, nextCursor: string | null, count = 1, state = 'open') =>
  json({ data: alertRows(title, count, state), nextCursor });
const pageButton = (name: 'Previous' | 'Next' | 'Latest') => screen.getByRole('button', { name });
const setupAlerts = (client = new QueryClient({ defaultOptions: { queries: { retry: false } } })) => {
  render(<QueryClientProvider client={client}><RecordsPage kind="alerts"/></QueryClientProvider>);
  return client;
};

it.each([[51, null], [1, '']] as const)('rejects an invalid alert page (%i rows, cursor %s)', async (count, cursor) => {
  await i18n.changeLanguage('en');
  const fetchMock = vi.fn(async (url: string) => {
    if (url !== alertsPath) throw new Error('Unexpected fixture request: ' + url);
    return alertPage('Malformed alert', cursor, count);
  });
  vi.stubGlobal('fetch', fetchMock);
  setupAlerts();
  expect(await screen.findByRole('alert')).toHaveTextContent('Unable to load data');
  expect(screen.queryByRole('article')).not.toBeInTheDocument();
  expect(pageButton('Next')).toBeDisabled();
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

it('uses state-bound opaque cursors, replaces rows, and resets page history with the filter', async () => {
  await i18n.changeLanguage('en');
  const acked = alertsPath + '&state=acked';
  const fetchMock = vi.fn(async (url: string) => {
    switch (url) {
      case alertsPath: return alertPage('Newest alert', pageToken, 50);
      case pageTwoPath: return alertPage('Older alert', 'third', 50);
      case pageThreePath: return alertPage('Oldest alert', null);
      case acked: return alertPage('Acknowledged alert', 'acked-only', 50, 'acked');
      case acked + '&cursor=acked-only': return alertPage('Older acknowledged alert', null, 1, 'acked');
      default: throw new Error('Unexpected fixture request: ' + url);
    }
  });
  vi.stubGlobal('fetch', fetchMock);
  setupAlerts();
  await screen.findByText(/Newest alert fixture 0/);
  expect(screen.getAllByRole('article')).toHaveLength(50);
  expect(screen.getByText('Page 1')).toHaveAttribute('role', 'status');
  expect(pageButton('Previous')).toBeDisabled();
  expect(pageButton('Latest')).toBeDisabled();
  expect(screen.queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument();

  fireEvent.click(pageButton('Next'));
  await screen.findByText('Page 2');
  expect(screen.getAllByRole('article')).toHaveLength(50);
  expect(screen.queryByText(/Newest alert fixture 0/)).not.toBeInTheDocument();
  fireEvent.click(pageButton('Next'));
  await screen.findByText('Page 3');
  expect(screen.getAllByRole('article')).toHaveLength(1);
  expect(pageButton('Next')).toBeDisabled();
  fireEvent.click(pageButton('Previous'));
  await screen.findByText('Page 2');
  expect(screen.queryByText(/Oldest alert fixture 0/)).not.toBeInTheDocument();
  fireEvent.click(pageButton('Latest'));
  await screen.findByText('Page 1');
  await screen.findByText(/Newest alert fixture 0/);
  expect(pageButton('Previous')).toBeDisabled();
  fireEvent.click(pageButton('Next'));
  await screen.findByText('Page 2');

  fireEvent.change(screen.getByRole('combobox', { name: 'Filter' }), { target: { value: 'acked' } });
  await screen.findByText(/Acknowledged alert fixture 0/);
  expect(screen.getByText('Page 1')).toBeInTheDocument();
  expect(screen.queryByText(/Older alert fixture 0/)).not.toBeInTheDocument();
  expect(pageButton('Previous')).toBeDisabled();
  expect(pageButton('Latest')).toBeDisabled();
  fireEvent.click(pageButton('Next'));
  await screen.findByText(/Older acknowledged alert fixture 0/);
  expect(screen.getByText('Page 2')).toBeInTheDocument();
  expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
    alertsPath, pageTwoPath, pageThreePath, pageTwoPath, alertsPath, pageTwoPath,
    acked, acked + '&cursor=acked-only',
  ]);
});

it('polls and reconciles only the current alert page, not its discarded predecessors', async () => {
  await i18n.changeLanguage('en');
  vi.useFakeTimers();
  try {
    let reads = 0;
    const fetchMock = vi.fn(async (url: string) => {
      switch (url) {
        case alertsPath: return alertPage('Newest alert', pageToken);
        case pageTwoPath: return alertPage('Older alert', 'third');
        case pageThreePath: return alertPage('Current read ' + ++reads, null);
        default: throw new Error('Unexpected fixture request: ' + url);
      }
    });
    vi.stubGlobal('fetch', fetchMock);
    const client = setupAlerts();
    const advance = async (ms: number) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };
    await advance(25);
    fireEvent.click(pageButton('Next'));
    await advance(25);
    fireEvent.click(pageButton('Next'));
    await advance(25);
    expect(screen.getByText('Page 3')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Current read 1' })).toBeInTheDocument();
    expect(client.getQueryCache().findAll({ queryKey: ['alerts'] })).toHaveLength(1);

    await advance(30_000);
    expect(screen.getByRole('heading', { name: 'Current read 2' })).toBeInTheDocument();
    syncEvent(client, 'alert.raised');
    await advance(25);
    expect(screen.getByRole('heading', { name: 'Current read 3' })).toBeInTheDocument();
    expect(screen.queryByText(/Older alert fixture/)).not.toBeInTheDocument();
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      alertsPath, pageTwoPath, pageThreePath, pageThreePath, pageThreePath,
    ]);
  } finally {
    cleanup();
    vi.useRealTimers();
  }
});

it('retains and polls the shown page after failed navigation; Retry revisits the failed cursor', async () => {
  await i18n.changeLanguage('en');
  vi.useFakeTimers();
  try {
    let attempts = 0;
    let release!: (value: Response) => void;
    const pending = new Promise<Response>(resolve => { release = resolve; });
    const fetchMock = vi.fn(async (url: string) => {
      if (url === alertsPath) return alertPage('Shown alert', pageToken);
      if (url !== pageTwoPath) throw new Error('Unexpected fixture request: ' + url);
      attempts++;
      if (attempts === 1) return pending;
      if (attempts === 3) return json({ error: { code: 'FAILED' } }, 500);
      return alertPage('Read ' + attempts, null);
    });
    vi.stubGlobal('fetch', fetchMock);
    const client = setupAlerts(new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 30_000 } } }));
    const advance = async (ms: number) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };
    await advance(25);
    const row = screen.getByRole('heading', { name: 'Shown alert' });
    fireEvent.click(pageButton('Next'));
    expect(screen.getByText('Loading…')).toBeInTheDocument();
    expect(row.closest('[aria-busy]')).toHaveAttribute('aria-busy', 'true');
    expect(pageButton('Next')).toBeDisabled();
    expect(screen.getByText('Page 1')).toBeInTheDocument();
    await advance(25);
    release(json({ error: { code: 'FAILED' } }, 500));
    await advance(25);
    expect(screen.getByRole('alert')).toHaveTextContent('Unable to load data');
    expect(row).toBeInTheDocument();
    expect(screen.getByText('Page 1')).toBeInTheDocument();

    await advance(30_000);
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([alertsPath, pageTwoPath, alertsPath]);
    expect(row).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await advance(25);
    const secondRow = screen.getByRole('heading', { name: 'Read 2' });
    expect(screen.getByText('Page 2')).toBeInTheDocument();
    expect(row).not.toBeInTheDocument();

    await client.invalidateQueries({ queryKey: ['alerts'] });
    await advance(25);
    expect(screen.getByRole('alert')).toHaveTextContent('Unable to load data');
    expect(secondRow).toBeInTheDocument();
    expect(screen.getByText('Page 2')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await advance(25);
    expect(screen.getByRole('heading', { name: 'Read 4' })).toBeInTheDocument();
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      alertsPath, pageTwoPath, alertsPath, pageTwoPath, pageTwoPath, pageTwoPath,
    ]);
  } finally {
    cleanup();
    vi.useRealTimers();
  }
});
it.each([['commands','/api/commands'],['audit','/api/audit-logs']] as const)('preserves cursor pagination for %s',async(kind,path)=>{
 await i18n.changeLanguage('en');
 const fetchMock=vi.fn().mockImplementation((url:string)=>Promise.resolve(new Response(JSON.stringify({data:[{id:url.includes('cursor=')?'second':'first',action:url.includes('cursor=')?'second page':'first page'}],nextCursor:url.includes('cursor=')?null:'next token'}),{status:200})));
 vi.stubGlobal('fetch',fetchMock);
 const client=new QueryClient({defaultOptions:{queries:{retry:false}}});
 render(<QueryClientProvider client={client}><RecordsPage kind={kind}/></QueryClientProvider>);
 await screen.findByText('first page');
 fireEvent.click(screen.getByRole('button',{name:'Load more'}));
 await screen.findByText('second page');
 expect(fetchMock.mock.calls.map(call=>call[0])).toEqual([path+'?limit=50',path+'?limit=50&cursor=next+token']);
});

it('keeps filters valid when navigating between record routes',async()=>{
 await i18n.changeLanguage('en');
 const fetchMock=vi.fn().mockImplementation(()=>Promise.resolve(new Response(JSON.stringify({data:[],nextCursor:null}),{status:200})));
 vi.stubGlobal('fetch',fetchMock);
 const client=new QueryClient({defaultOptions:{queries:{retry:false}}});
 render(<QueryClientProvider client={client}><MemoryRouter initialEntries={['/commands']}><Link to="/alerts">Alerts route</Link><Link to="/commands">Commands route</Link><Link to="/audit">Audit route</Link><Routes><Route path="/commands" element={<RecordsPage kind="commands"/>}/><Route path="/alerts" element={<RecordsPage kind="alerts"/>}/><Route path="/audit" element={<RecordsPage kind="audit"/>}/></Routes></MemoryRouter></QueryClientProvider>);
 await waitFor(()=>expect(fetchMock).toHaveBeenCalledWith('/api/commands?limit=50',expect.anything()));
 fireEvent.change(screen.getByRole('combobox',{name:'Filter'}),{target:{value:'qq'}});
 await waitFor(()=>expect(fetchMock).toHaveBeenCalledWith('/api/commands?limit=50&platform=qq',expect.anything()));
 fireEvent.click(screen.getByText('Alerts route'));
 await waitFor(()=>expect(fetchMock).toHaveBeenCalledWith(alertsPath,expect.anything()));
 expect(screen.getByRole('combobox')).toHaveValue('');
 fireEvent.change(screen.getByRole('combobox'),{target:{value:'acked'}});
 await waitFor(()=>expect(fetchMock).toHaveBeenCalledWith(alertsPath+'&state=acked',expect.anything()));
 fireEvent.click(screen.getByText('Audit route'));
 await waitFor(()=>expect(fetchMock).toHaveBeenCalledWith('/api/audit-logs?limit=50',expect.anything()));
 fireEvent.click(screen.getByText('Commands route'));
 await waitFor(()=>expect(screen.getByRole('combobox',{name:'Filter'})).toHaveValue(''));
 expect(fetchMock.mock.calls.map(call=>call[0])).not.toContain(alertsPath+'&state=qq');
 expect(fetchMock.mock.calls.map(call=>call[0])).not.toContain('/api/audit-logs?limit=50&platform=acked');
 expect(fetchMock.mock.calls.map(call=>call[0])).not.toContain('/api/commands?limit=50&platform=acked');
});
it('applies platform and kind filters to every command page',async()=>{
 await i18n.changeLanguage('en');
 const fetchMock=vi.fn().mockImplementation((url:string)=>Promise.resolve(new Response(JSON.stringify({data:[{id:url.includes('cursor=')?'next':'first',platform:'qq',kind:'sms',state:'queued'}],nextCursor:url.includes('kind=sms')&&!url.includes('cursor=')?'next':null}),{status:200})));
 vi.stubGlobal('fetch',fetchMock);const client=new QueryClient({defaultOptions:{queries:{retry:false}}});
 render(<QueryClientProvider client={client}><RecordsPage kind="commands"/></QueryClientProvider>);
 await screen.findByText('queued');
 fireEvent.change(screen.getByRole('combobox',{name:'Filter'}),{target:{value:'qq'}});
 fireEvent.change(screen.getByRole('combobox',{name:'Command kind'}),{target:{value:'sms'}});
 await waitFor(()=>expect(fetchMock).toHaveBeenCalledWith('/api/commands?limit=50&platform=qq&kind=sms',expect.anything()));
 fireEvent.click(await screen.findByRole('button',{name:'Load more'}));
 await waitFor(()=>expect(fetchMock).toHaveBeenCalledWith('/api/commands?limit=50&platform=qq&kind=sms&cursor=next',expect.anything()));
});
it('shows command details and distinguishes unavailable replies from an empty list',async()=>{
 await i18n.changeLanguage('en');
 vi.stubGlobal('fetch',vi.fn().mockResolvedValue(new Response(JSON.stringify({data:[
  {id:'req1',platform:'telegram',kind:'sms',state:'rejected',fromSimId:'sim_1',fromNumber:'111',toNumber:'222',toKind:'short',rejectCode:'DENIED',sessionId:'ses_1',smsTaskId:'tsk_1',body:'message body',rawText:'original command',createdAt:1},
  {id:'req2',platform:'qq',kind:'call',state:'ended',fromSimId:null,fromNumber:null,toNumber:'333',body:null,replies:[],createdAt:1},
  {id:'req3',platform:'qq',kind:'call',state:'ended',replies:[{text:'actual reply',ts:1}],createdAt:1}
 ],nextCursor:null}),{status:200})));
 const client=new QueryClient({defaultOptions:{queries:{retry:false}}});
 render(<QueryClientProvider client={client}><RecordsPage kind="commands"/></QueryClientProvider>);
 const first=(await screen.findByText('original command')).closest('article')!;
 for(const text of ['sms','rejected','sim_1','111','222 (short)','DENIED','ses_1','tsk_1','message body','Replies are unavailable.']) expect(within(first).getByText(text)).toBeInTheDocument();
 expect(screen.getByText('No replies.')).toBeInTheDocument();
 expect(screen.getByText(/actual reply/)).toBeInTheDocument();
 expect(screen.getByText(/actual reply/).querySelector('time')).toHaveAttribute('datetime',new Date(1).toISOString());
});
it('retains rows after a next-page failure and retries the same cursor',async()=>{
 await i18n.changeLanguage('en');let nextAttempts=0;
 const fetchMock=vi.fn().mockImplementation((url:string)=>{
  const next=url.includes('cursor=');if(next&&++nextAttempts===1) return Promise.resolve(new Response(JSON.stringify({error:{code:'FAILED'}}),{status:500}));
  return Promise.resolve(new Response(JSON.stringify({data:[{id:next?'second':'first',action:next?'second page':'first page'}],nextCursor:next?null:'next token'}),{status:200}));
 });
 vi.stubGlobal('fetch',fetchMock);const client=new QueryClient({defaultOptions:{queries:{retry:false}}});
 render(<QueryClientProvider client={client}><RecordsPage kind="audit"/></QueryClientProvider>);
 await screen.findByText('first page');fireEvent.click(screen.getByRole('button',{name:'Load more'}));
 await screen.findByText('Unable to load more records.');expect(screen.getByText('first page')).toBeInTheDocument();
 fireEvent.click(screen.getByRole('button',{name:'Retry'}));await screen.findByText('second page');
 expect(screen.getByText('first page')).toBeInTheDocument();expect(fetchMock.mock.calls.map(call=>call[0])).toEqual(['/api/audit-logs?limit=50','/api/audit-logs?limit=50&cursor=next+token','/api/audit-logs?limit=50&cursor=next+token']);
});
it('retains loaded rows on refetch failure and retries the refresh',async()=>{
 await i18n.changeLanguage('en');let calls=0;
 vi.stubGlobal('fetch',vi.fn().mockImplementation(()=>{calls++;return Promise.resolve(new Response(JSON.stringify(calls===2?{error:{code:'FAILED'}}:{data:[{id:'one',action:calls===1?'cached row':'refreshed row'}],nextCursor:null}),{status:calls===2?500:200}));}));
 const client=new QueryClient({defaultOptions:{queries:{retry:false}}});render(<QueryClientProvider client={client}><RecordsPage kind="audit"/></QueryClientProvider>);
 await screen.findByText('cached row');await client.invalidateQueries({queryKey:['audit']});
 await screen.findByText('Unable to load data. Try again later.');expect(screen.getByText('cached row')).toBeInTheDocument();
 fireEvent.click(screen.getByRole('button',{name:'Retry'}));await screen.findByText('refreshed row');
});
it('reads back an acknowledged channel alert without showing it as resolved',async()=>{
 await i18n.changeLanguage('en');
 let state='open';
 const fetchMock=vi.fn(async(_path:string,options?:RequestInit)=>{
  if(options?.method==='POST')state='acked';
  const alert={id:'alr1',type:'channel_down',state,subjectId:'telegram',severity:'warning',lastAt:1};
  return new Response(JSON.stringify({data:options?.method==='POST'?alert:[alert],nextCursor:null}),{status:200});
 });
 vi.stubGlobal('fetch',fetchMock);
 const client=new QueryClient({defaultOptions:{queries:{retry:false}}});
 render(<QueryClientProvider client={client}><RecordsPage kind="alerts"/></QueryClientProvider>);
 const card=(await screen.findByRole('heading',{name:'Platform channel is unavailable'})).closest('article')!;
 expect(within(card).getByText('State: Open')).toBeInTheDocument();
 fireEvent.click(within(card).getByRole('button',{name:'Acknowledge alert'}));
 expect(await within(card).findByText('State: Acknowledged')).toBeInTheDocument();
 expect(within(card).queryByText('State: Resolved')).not.toBeInTheDocument();
 expect(within(card).queryByRole('button',{name:'Acknowledge alert'})).not.toBeInTheDocument();
 expect(fetchMock).toHaveBeenCalledWith('/api/alerts/alr1/ack',expect.objectContaining({method:'POST'}));
});

it('reads back acknowledgement on the current Open page without visiting Latest', async () => {
  await i18n.changeLanguage('en');
  const open = alertsPath + '&state=open';
  const second = open + '&cursor=open-history';
  const post = '/api/alerts/older/ack';
  const target = { ...alertRows('channel_down')[0], id: 'older', subjectId: 'telegram' };
  let acknowledged = false;
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const fetchMock = vi.fn(async (url: string, options?: RequestInit) => {
    if (url === alertsPath) return alertPage('Unfiltered alert', null);
    if (url === open) return alertPage('Newest open alert', 'open-history', 50);
    if (url === second) return json({ data: acknowledged ? [] : [target], nextCursor: null });
    if (url === post && options?.method === 'POST') {
      await pending;
      acknowledged = true;
      return json({ data: { ...target, state: 'acked' } });
    }
    throw new Error('Unexpected fixture request: ' + url);
  });
  vi.stubGlobal('fetch', fetchMock);
  setupAlerts();
  await screen.findByRole('heading', { name: 'Unfiltered alert' });
  fireEvent.change(screen.getByRole('combobox', { name: 'Filter' }), { target: { value: 'open' } });
  await screen.findByText(/Newest open alert fixture 0/);
  fireEvent.click(pageButton('Next'));
  const row = await screen.findByRole('heading', { name: 'Platform channel is unavailable' });
  const ack = screen.getByRole('button', { name: 'Acknowledge alert' });
  fireEvent.click(ack);
  expect(await screen.findByText('Loading…')).toBeInTheDocument();
  expect(ack).toBeDisabled();
  expect(pageButton('Previous')).toBeDisabled();
  release();
  await waitFor(() => expect(row).not.toBeInTheDocument());
  expect(screen.getByText('Page 2')).toBeInTheDocument();
  expect(pageButton('Previous')).toBeEnabled();
  expect(screen.queryByText('State: Resolved')).not.toBeInTheDocument();
  expect(fetchMock.mock.calls.map(([url, options]) => [url, options?.method])).toEqual([
    [alertsPath, 'GET'], [open, 'GET'], [second, 'GET'], [post, 'POST'], [second, 'GET'],
  ]);
});

it.each([[404, 'NOT_FOUND'], [503, 'TIMEOUT_UNKNOWN']])(
  'shows an acknowledgement error %i, reads back without resubmitting, and makes no recovery claim',
  async (status, code) => {
    await i18n.changeLanguage('en');
    const fetchMock = vi.fn(async (url: string, options?: RequestInit) => {
      if (url === '/api/alerts/alr-fixture/ack' && options?.method === 'POST') {
        return json({ error: { code } }, status);
      }
      if (url !== alertsPath) throw new Error('Unexpected fixture request: ' + url);
      return json({
        data: [{ ...alertRows('channel_down')[0], id: 'alr-fixture', subjectId: 'telegram' }],
        nextCursor: null,
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    setupAlerts(new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: 2 } } }));
    await screen.findByRole('heading', { name: 'Platform channel is unavailable' });
    fireEvent.click(screen.getByRole('button', { name: 'Acknowledge alert' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(code);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Acknowledge alert' })).toBeEnabled());
    expect(screen.getByText('State: Open')).toBeInTheDocument();
    expect(screen.queryByText('State: Acknowledged')).not.toBeInTheDocument();
    expect(screen.queryByText('State: Resolved')).not.toBeInTheDocument();
    expect(fetchMock.mock.calls.map(([url, options]) => [url, options?.method])).toEqual([
      [alertsPath, 'GET'], ['/api/alerts/alr-fixture/ack', 'POST'], [alertsPath, 'GET'],
    ]);
  },
);
