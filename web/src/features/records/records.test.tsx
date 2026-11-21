import {act,cleanup,fireEvent,render,screen,waitFor,within} from '@testing-library/react';
import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
import {Link,MemoryRouter,Route,Routes} from 'react-router-dom';
import {afterEach,expect,it,vi} from 'vitest';
import {RecordsPage} from './records';
import i18n from '../../i18n';
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

it('requests alerts with only the supported state filter',async()=>{
 await i18n.changeLanguage('en');
 const fetchMock=vi.fn().mockImplementation((url:string)=>{
  const parsed=new URL(url,'http://localhost');
  const keys=[...parsed.searchParams.keys()];
  const valid=parsed.pathname==='/api/alerts'&&keys.every(key=>key==='state')&&keys.length<=1;
  return Promise.resolve(new Response(JSON.stringify(valid?{data:[{id:'a',type:'offline',state:parsed.searchParams.get('state')??'open'}],nextCursor:'unexpected'}:{error:{code:'BAD_REQUEST'}}),{status:valid?200:400}));
 });
 vi.stubGlobal('fetch',fetchMock);
 const client=new QueryClient({defaultOptions:{queries:{retry:false}}});
 render(<QueryClientProvider client={client}><RecordsPage kind="alerts"/></QueryClientProvider>);
 await screen.findByText('offline');
 expect(fetchMock.mock.calls.map(call=>call[0])).toEqual(['/api/alerts']);
 expect(screen.queryByRole('button',{name:'Load more'})).not.toBeInTheDocument();
 fireEvent.change(screen.getByRole('combobox'),{target:{value:'acked'}});
 await waitFor(()=>expect(fetchMock.mock.calls.map(call=>call[0])).toEqual(['/api/alerts','/api/alerts?state=acked']));
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
 await waitFor(()=>expect(fetchMock).toHaveBeenCalledWith('/api/alerts',expect.anything()));
 expect(screen.getByRole('combobox')).toHaveValue('');
 fireEvent.change(screen.getByRole('combobox'),{target:{value:'acked'}});
 await waitFor(()=>expect(fetchMock).toHaveBeenCalledWith('/api/alerts?state=acked',expect.anything()));
 fireEvent.click(screen.getByText('Audit route'));
 await waitFor(()=>expect(fetchMock).toHaveBeenCalledWith('/api/audit-logs?limit=50',expect.anything()));
 fireEvent.click(screen.getByText('Commands route'));
 await waitFor(()=>expect(screen.getByRole('combobox',{name:'Filter'})).toHaveValue(''));
 expect(fetchMock.mock.calls.map(call=>call[0])).not.toContain('/api/alerts?state=qq');
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
it('acknowledges an open alert using its endpoint',async()=>{await i18n.changeLanguage('en');const f=vi.fn().mockImplementation((_url:string,options?:RequestInit)=>Promise.resolve(new Response(JSON.stringify({data:options?.method==='POST'?{}:[{id:'alr1',type:'offline',state:'open',subjectId:'dev',severity:'critical',lastAt:1}],nextCursor:null}),{status:200})));vi.stubGlobal('fetch',f);const client=new QueryClient({defaultOptions:{queries:{retry:false}}});render(<QueryClientProvider client={client}><RecordsPage kind="alerts"/></QueryClientProvider>);fireEvent.click(await screen.findByRole('button',{name:'Acknowledge alert'}));await waitFor(()=>expect(f.mock.calls.some(call=>call[0]==='/api/alerts/alr1/ack'&&call[1]?.method==='POST')).toBe(true));});
