import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AppProviders } from '../../app/providers';
import { AppRouter } from '../../app/router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { SmsPage } from './sms';
import { useSession } from '../../stores/session';
import i18n from '../../i18n';
beforeEach(()=>{
  vi.stubGlobal('WebSocket', class { close() {} });
  useSession.getState().setSession({username:'admin',token:'fake',expiresAt:Date.now()+60000});
});
afterEach(()=>{cleanup();sessionStorage.clear();vi.unstubAllGlobals();useSession.getState().setSession(null);});
it('reads null SIM conversation without mixing SIMs or allowing replies',async()=>{
  await i18n.changeLanguage('en');
  useSession.getState().setSession({token:'fake',expiresAt:Date.now()+60000,username:'admin'});
  window.history.pushState({},'','/sms/dev%3Anull%3A123');
  const fetchMock=vi.fn().mockImplementation((url:string)=>Promise.resolve(new Response(JSON.stringify(url.startsWith('/api/sms/threads') ? {data:[{key:'dev:null:123',deviceId:'dev',simId:null,peer:'123',lastBody:'preview',lastAt:0}],nextCursor:null} : {data:[{id:'msg',direction:'in',peer:'123',body:'No SIM message',occurredAt:0,task:null}],nextCursor:null}),{status:200})));
  vi.stubGlobal('fetch',fetchMock);
  render(<AppProviders><AppRouter/></AppProviders>);
  expect(await screen.findByText('No SIM message')).toBeInTheDocument();
  const url = new URL(String(fetchMock.mock.calls.find(([u])=>String(u).startsWith('/api/sms?'))?.[0]),'http://localhost');
  expect(url.searchParams.get('simId')).toBe('null');
  expect(screen.queryByRole('button',{name:'Send message'})).not.toBeInTheDocument();
});

it.each([true,false])('only exposes reply when the SIM is currently present: %s',async(active)=>{
  await i18n.changeLanguage('en');
  const {useConnection}=await import('../../realtime/use-admin-socket');
  useConnection.getState().setState('connected');
  useSession.getState().setSession({token:'fake',expiresAt:Date.now()+60000,username:'admin'});
  window.history.pushState({},'','/sms/dev%3Asim%3A123');
  const fetchMock=vi.fn().mockImplementation((url:string)=>{
    const data=url.startsWith('/api/sms/threads') ? [{key:'dev:sim:123',deviceId:'dev',simId:'sim',peer:'123',lastBody:'preview',lastAt:0}] : url.startsWith('/api/devices/') ? {id:'dev',enabled:true,paused:false,sims:active?[{id:'sim',state:'ready'}]:[]} : [{id:'msg',direction:'in',peer:'123',body:'Historical message',occurredAt:0,task:null}];
    return Promise.resolve(new Response(JSON.stringify({data,nextCursor:null}),{status:200}));
  });
  vi.stubGlobal('fetch',fetchMock);
  render(<QueryClientProvider client={new QueryClient({defaultOptions:{queries:{retry:false}}})}><MemoryRouter initialEntries={['/sms/dev%3Asim%3A123']}><Routes><Route path="/sms/:threadKey" element={<SmsPage/>}/></Routes></MemoryRouter></QueryClientProvider>);
  expect(await screen.findByText('Historical message')).toBeInTheDocument();
  if(active) { expect(await screen.findByRole('button',{name:'Send message'})).toBeInTheDocument(); expect(screen.getByText(/SIM readiness is unknown or out of date/)).toBeInTheDocument(); }
  else expect(await screen.findByText('Sending is unavailable until the current device and SIM are verified as active and ready.')).toBeInTheDocument();
  useConnection.getState().setState('disconnected');
});

it('fails closed when the current device SIM collection is malformed',async()=>{
  await i18n.changeLanguage('en');
  vi.stubGlobal('fetch',vi.fn().mockImplementation((url:string)=>{
    const data=url.startsWith('/api/sms/threads') ? [{key:'dev:sim:123',deviceId:'dev',simId:'sim',peer:'123',lastBody:'preview',lastAt:0}] : url.startsWith('/api/devices/') ? {id:'dev',enabled:true,paused:false,sims:{}} : [{id:'msg',direction:'in',peer:'123',body:'Message retained',occurredAt:0,task:null}];
    return Promise.resolve(new Response(JSON.stringify({data,nextCursor:null}),{status:200}));
  }));
  render(<QueryClientProvider client={new QueryClient({defaultOptions:{queries:{retry:false}}})}><MemoryRouter initialEntries={['/sms/dev%3Asim%3A123']}><Routes><Route path="/sms/:threadKey" element={<SmsPage/>}/></Routes></MemoryRouter></QueryClientProvider>);
  expect(await screen.findByText('Message retained')).toBeInTheDocument();
  expect(await screen.findByText('Sending is unavailable until the current device and SIM are verified as active and ready.')).toBeInTheDocument();
  expect(screen.getByRole('button',{name:'Send message'})).toBeDisabled();
});

it('requires an explicit current SIM to reply to an unassigned message',async()=>{
 await i18n.changeLanguage('en');
 const mock=vi.fn().mockImplementation((url:string,opts?:RequestInit)=>{
  if(opts?.method==='POST') return Promise.resolve(new Response(JSON.stringify({data:{id:'out',simId:'chosen',body:'Reply',peer:'123',direction:'out',deviceId:'dev',occurredAt:1,task:{id:'task',state:'queued',updatedAt:1}}}),{status:200}));
  const data=url.startsWith('/api/sms/threads')?[{key:'dev:null:123',deviceId:'dev',simId:null,peer:'123',lastBody:'preview'}]:url.startsWith('/api/devices/')?{id:'dev',name:'Gateway',enabled:true,paused:false,sims:[{id:'chosen',slot:0,state:'ready',number:'111',lastSeenAt:Date.now()},{id:'locked',slot:1,state:'locked',number:'222'}]}:[{id:'incoming',direction:'in',body:'Original message',peer:'123',task:null}];
  return Promise.resolve(new Response(JSON.stringify({data,nextCursor:null}),{status:200}));
 });
 vi.stubGlobal('fetch',mock);
 render(<QueryClientProvider client={new QueryClient({defaultOptions:{queries:{retry:false}}})}><MemoryRouter initialEntries={['/sms/dev%3Anull%3A123']}><Routes><Route path="/sms/:threadKey" element={<SmsPage/>}/></Routes></MemoryRouter></QueryClientProvider>);
 expect(await screen.findByText('Original message')).toBeInTheDocument();
 expect(screen.getByText(/The receiving SIM is unknown/)).toBeInTheDocument();
 const selector=await screen.findByLabelText('Sending SIM');
 expect(selector).toHaveValue('');
 expect(screen.queryByRole('option',{name:/locked/})).not.toBeInTheDocument();
 expect(screen.queryByRole('button',{name:'Send message'})).not.toBeInTheDocument();
 fireEvent.change(selector,{target:{value:'chosen'}});
 fireEvent.change(screen.getByLabelText('Message'),{target:{value:'Reply'}});
 fireEvent.click(screen.getByRole('button',{name:'Send message'}));
 await waitFor(()=>expect(mock.mock.calls.some(([url,opts])=>url==='/api/sms' && opts?.method==='POST')).toBe(true));
 const sent=mock.mock.calls.find(([url,opts])=>url==='/api/sms' && opts?.method==='POST');
 expect(JSON.parse(String(sent?.[1]?.body))).toEqual({simId:'chosen',to:'123',body:'Reply'});
 expect(mock.mock.calls.some(([url])=>String(url).startsWith('/api/sms?') && new URL(String(url),'http://localhost').searchParams.get('simId')==='null')).toBe(true);
 expect(mock.mock.calls.some(([url])=>String(url)==='/api/devices/dev')).toBe(true);
});

it('keeps draft during verification and requires reselection after SIM disappears',async()=>{
 await i18n.changeLanguage('en');
 let sims=[{id:'sim',slot:0,state:'ready',number:'111'}]; let release:((value:Response)=>void)|undefined; let delayed=false;
 const reply=()=>new Response(JSON.stringify({data:{id:'dev',name:'Gateway',enabled:true,paused:false,sims}}),{status:200});
 vi.stubGlobal('fetch',vi.fn().mockImplementation((url:string)=>{
  if(url.startsWith('/api/devices/')) return delayed ? new Promise<Response>(resolve=>{release=resolve;}) : Promise.resolve(reply());
  return Promise.resolve(new Response(JSON.stringify({data:url.startsWith('/api/sms/threads')?[{key:'dev:null:123',deviceId:'dev',simId:null,peer:'123',lastBody:'preview'}]:[{id:'in',direction:'in',body:'Inbound',task:null}],nextCursor:null}),{status:200}));
 }));
 const client=new QueryClient({defaultOptions:{queries:{retry:false}}});
 render(<QueryClientProvider client={client}><MemoryRouter initialEntries={['/sms/dev%3Anull%3A123']}><Routes><Route path="/sms/:threadKey" element={<SmsPage/>}/></Routes></MemoryRouter></QueryClientProvider>);
 const select=await screen.findByLabelText('Sending SIM'); fireEvent.change(select,{target:{value:'sim'}});
 fireEvent.change(screen.getByLabelText('Message'),{target:{value:'draft'}});
 delayed=true; void client.invalidateQueries({queryKey:['devices','sms-eligibility','dev']});
 await waitFor(()=>expect(release).toBeDefined()); expect(screen.getByLabelText('Message')).toHaveValue('draft'); expect(screen.getByRole('button',{name:'Send message'})).toBeDisabled();
 sims=[]; release!(reply()); await waitFor(()=>expect(select).toHaveValue('')); expect(screen.getByLabelText('Message')).toHaveValue('draft');
 delayed=false; sims=[{id:'sim',slot:0,state:'ready',number:'111'}]; await client.invalidateQueries({queryKey:['devices','sms-eligibility','dev']});
 await screen.findByRole('option',{name:/111/}); expect(select).toHaveValue(''); expect(screen.getByRole('button',{name:'Send message'})).toBeDisabled();
});

it('retains uncertain send and locks SIM through a failed messages refresh',async()=>{
 await i18n.changeLanguage('en'); let messageReads=0;
 const mock=vi.fn().mockImplementation((url:string,opts?:RequestInit)=>{
  if(opts?.method==='POST') return Promise.reject(new Error('network'));
  if(url.startsWith('/api/devices/')) return Promise.resolve(new Response(JSON.stringify({data:{id:'dev',name:'Gateway',enabled:true,paused:false,sims:[{id:'sim',slot:0,state:'ready',number:'111'}]}}),{status:200}));
  if(url.startsWith('/api/sms/threads')) return Promise.resolve(new Response(JSON.stringify({data:[{key:'dev:null:123',deviceId:'dev',simId:null,peer:'123',lastBody:'preview'}],nextCursor:null}),{status:200}));
  if(++messageReads>1) return Promise.resolve(new Response(JSON.stringify({error:{code:'FAIL'}}),{status:500}));
  return Promise.resolve(new Response(JSON.stringify({data:[{id:'msg',direction:'in',body:'Inbound',task:null}],nextCursor:null}),{status:200}));
 });
 vi.stubGlobal('fetch',mock); const client=new QueryClient({defaultOptions:{queries:{retry:false}}});
 render(<QueryClientProvider client={client}><MemoryRouter initialEntries={['/sms/dev%3Anull%3A123']}><Routes><Route path="/sms/:threadKey" element={<SmsPage/>}/></Routes></MemoryRouter></QueryClientProvider>);
 const selector=await screen.findByLabelText('Sending SIM'); fireEvent.change(selector,{target:{value:'sim'}});
 fireEvent.change(screen.getByLabelText('Message'),{target:{value:'hello'}}); fireEvent.click(screen.getByRole('button',{name:'Send message'}));
 expect((await screen.findAllByText(/The result may be unknown/)).length).toBeGreaterThan(0); expect(selector).toBeDisabled(); expect(screen.getAllByLabelText('Message').every(field=>field instanceof HTMLTextAreaElement && field.value==='hello')).toBe(true);
 await client.invalidateQueries({queryKey:['sms','thread','dev:null:123']});
 expect(await screen.findByText('Unable to load data. Try again later.')).toBeInTheDocument(); expect(screen.getAllByLabelText('Message').every(field=>field instanceof HTMLTextAreaElement && field.value==='hello')).toBe(true);
 fireEvent.click(screen.getAllByRole('button',{name:'Resume pending message'})[0]); await waitFor(()=>expect(mock.mock.calls.filter(([url,opts])=>url==='/api/sms' && opts?.method==='POST')).toHaveLength(2));
 const sends=mock.mock.calls.filter(([url,opts])=>url==='/api/sms' && opts?.method==='POST'); expect(sends[0][1].headers.get('Idempotency-Key')).toBe(sends[1][1].headers.get('Idempotency-Key'));
});