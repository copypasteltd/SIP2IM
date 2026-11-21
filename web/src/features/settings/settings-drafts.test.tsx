import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import i18n from '../../i18n';
import { Form, SettingsPage } from './settings';

const initial = {smsForward:false,smsRatePerMin:10,heartbeatSec:30,offlineAfterSec:90,botLocale:'en' as const,defaultDeviceId:null,inboundRingTimeoutSec:20,outboundUserAnswerTimeoutSec:15,outboundCalleeAnswerTimeoutSec:30,outboundCallbackRingTimeoutSec:30,alertPushIntervalSec:1800,earlyMediaThresholdDbfs:-50};
afterEach(()=>{cleanup();vi.unstubAllGlobals();});
async function setup() {
  await i18n.changeLanguage('en');
  const client=new QueryClient({defaultOptions:{queries:{retry:false},mutations:{retry:false}}});
  const fetcher=vi.fn().mockImplementation((_url:string,options?:RequestInit)=>Promise.resolve(new Response(JSON.stringify({data:options?.method==='PUT'?{...initial,...JSON.parse(String(options.body)).changes}:initial}),{status:200})));
  const writes=()=>fetcher.mock.calls.filter(call=>call[1]?.method==='PUT');
  vi.stubGlobal('fetch',fetcher);
  const renderForm=(settings:typeof initial)=><QueryClientProvider client={client}><Form settings={settings}/></QueryClientProvider>;
  const view=render(renderForm(initial));
  return {fetcher,writes,update:(patch:Partial<typeof initial>)=>view.rerender(renderForm({...initial,...patch}))};
}
function saveButton(heading:string) { return within(screen.getByRole('heading',{name:heading}).closest('form')!).getByRole('button',{name:'Save'}); }
it('adopts clean external siblings and submits only edited SMS fields',async()=>{
  const {writes,update}=await setup();
  fireEvent.click(screen.getByLabelText('Forward messages'));
  update({smsRatePerMin:25});
  expect(screen.getByLabelText('Messages per minute (blank disables)')).toHaveValue(25);
  fireEvent.click(saveButton('Message settings'));
  await waitFor(()=>expect(writes()).toHaveLength(1));
  expect(JSON.parse(writes()[0][1]!.body as string)).toEqual({changes:{smsForward:true},expected:{smsForward:false}});
});
it('preserves dirty edits, requires explicit conflict resolution, and sends only the chosen edit',async()=>{
  const {writes,update}=await setup();
  const heartbeat=screen.getByLabelText('Heartbeat interval (seconds)');
  fireEvent.change(heartbeat,{target:{value:'40'}});
  update({heartbeatSec:50,offlineAfterSec:100});
  expect(heartbeat).toHaveValue(40);
  expect(screen.getByLabelText('Offline threshold (seconds)')).toHaveValue(100);
  expect(saveButton('Timing settings')).toBeDisabled();
  fireEvent.click(screen.getByRole('button',{name:'Keep my edit'}));
  fireEvent.click(saveButton('Timing settings'));
  await waitFor(()=>expect(writes()).toHaveLength(1));
  expect(JSON.parse(writes()[0][1]!.body as string)).toEqual({changes:{heartbeatSec:40},expected:{heartbeatSec:50}});
});
it('does not silently resolve a conflict when an edit returns to its old baseline',async()=>{
  const {writes,update}=await setup();
  const heartbeat=screen.getByLabelText('Heartbeat interval (seconds)');
  fireEvent.change(heartbeat,{target:{value:'40'}});
  update({heartbeatSec:50});
  fireEvent.change(heartbeat,{target:{value:'30'}});
  expect(screen.getByRole('button',{name:'Keep my edit'})).toBeInTheDocument();
  expect(saveButton('Timing settings')).toBeDisabled();
  update({heartbeatSec:60});
  expect(heartbeat).toHaveValue(30);
  expect(saveButton('Timing settings')).toBeDisabled();
  fireEvent.click(screen.getByRole('button',{name:'Keep my edit'}));
  fireEvent.click(saveButton('Timing settings'));
  await waitFor(()=>expect(writes()).toHaveLength(1));
  expect(JSON.parse(writes()[0][1]!.body as string)).toEqual({changes:{heartbeatSec:30},expected:{heartbeatSec:60}});
});
it('can discard a conflicting draft and adopts a matching external value',async()=>{
  const {update}=await setup();
  const heartbeat=screen.getByLabelText('Heartbeat interval (seconds)');
  fireEvent.change(heartbeat,{target:{value:'40'}});
  update({heartbeatSec:50});
  fireEvent.click(screen.getByRole('button',{name:'Use latest'}));
  expect(heartbeat).toHaveValue(50);
  expect(saveButton('Timing settings')).toBeDisabled();
  fireEvent.change(heartbeat,{target:{value:'60'}});
  update({heartbeatSec:60});
  expect(screen.queryByRole('button',{name:'Keep my edit'})).not.toBeInTheDocument();
  expect(saveButton('Timing settings')).toBeDisabled();
});
it('does not overwrite a newer external value when an older save finishes',async()=>{
  const {fetcher,update}=await setup();
  let resolve!: (response:Response)=>void;
  fetcher.mockImplementationOnce(()=>new Promise<Response>(r=>{resolve=r;}));
  fireEvent.change(screen.getByLabelText('Heartbeat interval (seconds)'),{target:{value:'40'}});
  fireEvent.click(saveButton('Timing settings'));
  update({heartbeatSec:50});
  expect(await screen.findByRole('button',{name:'Keep my edit'})).toBeInTheDocument();
  resolve(new Response(JSON.stringify({data:{...initial,heartbeatSec:40}}),{status:200}));
  await waitFor(()=>expect(saveButton('Timing settings')).toBeDisabled());
  expect(screen.getByLabelText('Heartbeat interval (seconds)')).toHaveValue(40);
  expect(screen.getByRole('button',{name:'Use latest'})).toBeInTheDocument();
  await waitFor(()=>expect(screen.getByRole('button',{name:'Use latest'})).toBeEnabled());
  fireEvent.click(screen.getByRole('button',{name:'Use latest'}));
  expect(screen.getByLabelText('Heartbeat interval (seconds)')).toHaveValue(50);
});
it('reports a committed write with unconfirmed effects separately',async()=>{
  const {fetcher}=await setup();
  fetcher.mockResolvedValueOnce(new Response(JSON.stringify({error:{code:'SETTINGS_WRITE_COMMITTED_EFFECTS_UNKNOWN'}}),{status:503}));
  fireEvent.click(screen.getByLabelText('Forward messages'));
  fireEvent.click(saveButton('Message settings'));
  expect(await screen.findByText(/settings were saved, but follow-up effects/i)).toBeInTheDocument();
  expect(fetcher).toHaveBeenCalledTimes(1);
});
it('reports an invalid request as rejected',async()=>{
  const {fetcher}=await setup();
  fetcher.mockResolvedValueOnce(new Response(JSON.stringify({error:{code:'BAD_REQUEST'}}),{status:400}));
  fireEvent.click(screen.getByLabelText('Forward messages'));
  fireEvent.click(saveButton('Message settings'));
  expect(await screen.findByText(/server rejected the save/i)).toBeInTheDocument();
  expect(screen.queryByText(/save result may be uncertain/i)).not.toBeInTheDocument();
});
it('keeps save disabled until the post-save refresh settles',async()=>{
  await i18n.changeLanguage('en');
  const client=new QueryClient({defaultOptions:{queries:{retry:false}}});
  let resolveRefresh!: (response:Response)=>void;
  let settingsGets=0;
  const fetcher=vi.fn().mockImplementation((url:string,options?:RequestInit)=>{
    if (!url.startsWith('/api/settings')) return Promise.resolve(new Response(JSON.stringify({data:[],nextCursor:null}),{status:200}));
    if (options?.method==='PUT') return Promise.resolve(new Response(JSON.stringify({data:{...initial,smsForward:true}}),{status:200}));
    if (++settingsGets===1) return Promise.resolve(new Response(JSON.stringify({data:initial}),{status:200}));
    return new Promise<Response>(resolve=>{resolveRefresh=resolve;});
  });
  vi.stubGlobal('fetch',fetcher);
  render(<QueryClientProvider client={client}><SettingsPage/></QueryClientProvider>);
  fireEvent.click(await screen.findByLabelText('Forward messages'));
  fireEvent.click(saveButton('Message settings'));
  await waitFor(()=>expect(settingsGets).toBe(2));
  expect(saveButton('Message settings')).toBeDisabled();
  fireEvent.click(saveButton('Message settings'));
  expect(fetcher.mock.calls.filter(call=>call[1]?.method==='PUT')).toHaveLength(1);
  resolveRefresh(new Response(JSON.stringify({data:{...initial,smsForward:true}}),{status:200}));
  await waitFor(()=>expect(screen.getByLabelText('Forward messages')).toBeEnabled());
  expect(saveButton('Message settings')).toBeDisabled();
});
it('keeps unsaved drafts mounted after a background settings refresh fails',async()=>{
  await i18n.changeLanguage('en');
  const client=new QueryClient({defaultOptions:{queries:{retry:false}}});
  const fetcher=vi.fn().mockImplementation((url:string)=>url.startsWith('/api/settings')
    ? Promise.resolve(new Response(JSON.stringify({data:initial}),{status:200}))
    : Promise.resolve(new Response(JSON.stringify({data:[],nextCursor:null}),{status:200})));
  vi.stubGlobal('fetch',fetcher);
  render(<QueryClientProvider client={client}><SettingsPage/></QueryClientProvider>);
  const heartbeat=await screen.findByLabelText('Heartbeat interval (seconds)');
  fireEvent.change(heartbeat,{target:{value:'40'}});
  fetcher.mockImplementation((url:string)=>url.startsWith('/api/settings')
    ? Promise.reject(new TypeError('network'))
    : Promise.resolve(new Response(JSON.stringify({data:[],nextCursor:null}),{status:200})));
  await client.invalidateQueries({queryKey:['settings']});
  expect(await screen.findByText(/could not refresh settings/i)).toBeInTheDocument();
  expect(screen.getByLabelText('Heartbeat interval (seconds)')).toBe(heartbeat);
  expect(heartbeat).toHaveValue(40);
  expect(saveButton('Timing settings')).toBeEnabled();
});
it('warns after an uncertain failed write and does not retry it',async()=>{
  const {fetcher}=await setup();
  fetcher.mockRejectedValueOnce(new TypeError('network'));
  fireEvent.click(screen.getByLabelText('Forward messages'));
  fireEvent.click(saveButton('Message settings'));
  expect(await screen.findByText(/save result may be uncertain/i)).toBeInTheDocument();
  expect(fetcher).toHaveBeenCalledTimes(1);
});
