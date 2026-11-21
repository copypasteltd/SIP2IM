import {cleanup,fireEvent,render,screen,waitFor,within} from '@testing-library/react';
import {afterEach,expect,it,vi} from 'vitest';
import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
import i18n from '../../i18n';
import {MoreSettings} from './more-settings';

const initial = {defaultDeviceId:null,inboundRingTimeoutSec:20,outboundUserAnswerTimeoutSec:15,outboundCalleeAnswerTimeoutSec:30,outboundCallbackRingTimeoutSec:30,alertPushIntervalSec:1800,earlyMediaThresholdDbfs:-50,smsForward:true,smsRatePerMin:10,heartbeatSec:45,offlineAfterSec:90,botLocale:'en' as const,inboundPlatform:'telegram'};
afterEach(()=>{cleanup();vi.unstubAllGlobals();});
function setup() {
  const fetcher=vi.fn().mockImplementation((url:string,options?:RequestInit)=>Promise.resolve(new Response(JSON.stringify({data:url.startsWith('/api/devices')?[]:options?.method==='PUT'?{...initial,...JSON.parse(String(options.body)).changes}:initial}),{status:200})));
  vi.stubGlobal('fetch',fetcher);
  const client=new QueryClient({defaultOptions:{queries:{retry:false},mutations:{retry:false}}});
  const renderForm=(settings:Omit<typeof initial,'defaultDeviceId'> & {defaultDeviceId:string|null})=><QueryClientProvider client={client}><MoreSettings settings={settings}/></QueryClientProvider>;
  return {fetcher,renderForm};
}
function timingForm() {return screen.getByRole('heading',{name:'Call and alert timing'}).closest('form')!;}
function putBodies(fetcher:ReturnType<typeof vi.fn>) {return fetcher.mock.calls.filter(call=>call[1]?.method==='PUT').map(call=>JSON.parse(call[1].body));}

it('sends only edited timing fields, never unrelated runtime props or unchanged fields',async()=>{
  await i18n.changeLanguage('en');
  const {fetcher,renderForm}=setup();render(renderForm(initial));
  fireEvent.change(screen.getByLabelText('Incoming ring timeout (seconds)'),{target:{value:'25'}});
  fireEvent.click(within(timingForm()).getByRole('button',{name:'Save'}));
  await waitFor(()=>expect(putBodies(fetcher)).toEqual([{changes:{inboundRingTimeoutSec:25},expected:{inboundRingTimeoutSec:20}}]));
});

it('updates clean values, preserves dirty edits, and blocks observed same-field conflicts until resolved',async()=>{
  await i18n.changeLanguage('en');
  const {fetcher,renderForm}=setup();const view=render(renderForm(initial));
  const edited=screen.getByLabelText('Incoming ring timeout (seconds)') as HTMLInputElement;
  fireEvent.change(edited,{target:{value:'25'}});
  view.rerender(renderForm({...initial,inboundRingTimeoutSec:22,outboundUserAnswerTimeoutSec:17,smsForward:false}));
  expect(edited.value).toBe('25');
  expect((screen.getByLabelText('Wait for user answer (seconds)') as HTMLInputElement).value).toBe('17');
  expect(screen.getByText('This value changed elsewhere to 22. Review it before saving.')).toBeInTheDocument();
  expect(within(timingForm()).getByRole('button',{name:'Save'})).toBeDisabled();
  fireEvent.submit(timingForm());
  expect(putBodies(fetcher)).toEqual([]);
  fireEvent.click(screen.getByRole('button',{name:'Use latest value'}));
  expect(edited.value).toBe('22');
  fireEvent.change(screen.getByLabelText('Wait for user answer (seconds)'),{target:{value:'19'}});
  fireEvent.click(within(timingForm()).getByRole('button',{name:'Save'}));
  await waitFor(()=>expect(putBodies(fetcher)).toEqual([{changes:{outboundUserAnswerTimeoutSec:19},expected:{outboundUserAnswerTimeoutSec:17}}]));
});

it('adopts acknowledged props during a pending save and follows later updates',async()=>{
  await i18n.changeLanguage('en');
  const {fetcher,renderForm}=setup();
  let finish!: (response:Response)=>void;
  fetcher.mockImplementation((_url:string,options?:RequestInit)=>options?.method==='PUT' ? new Promise<Response>(resolve=>{finish=resolve;}) : Promise.resolve(new Response(JSON.stringify({data:_url.startsWith('/api/devices')?[]:{...initial,inboundRingTimeoutSec:25,outboundUserAnswerTimeoutSec:18}}),{status:200})));
  const view=render(renderForm(initial));
  const edited=screen.getByLabelText('Incoming ring timeout (seconds)') as HTMLInputElement;
  fireEvent.change(edited,{target:{value:'25'}});
  fireEvent.click(within(timingForm()).getByRole('button',{name:'Save'}));
  await waitFor(()=>expect(edited).toBeDisabled());
  view.rerender(renderForm({...initial,inboundRingTimeoutSec:25,outboundUserAnswerTimeoutSec:18}));
  finish(new Response(JSON.stringify({data:{...initial,inboundRingTimeoutSec:25,outboundUserAnswerTimeoutSec:18}}),{status:200}));
  await waitFor(()=>expect(edited).not.toBeDisabled());
  view.rerender(renderForm({...initial,inboundRingTimeoutSec:27,outboundUserAnswerTimeoutSec:18}));
  await waitFor(()=>expect(edited.value).toBe('27'));
  expect(screen.queryByText(/changed elsewhere/)).not.toBeInTheDocument();
  expect(putBodies(fetcher)).toEqual([{changes:{inboundRingTimeoutSec:25},expected:{inboundRingTimeoutSec:20}}]);
});

it('keeps a dirty device on refresh, blocks conflict, and saves only a newly chosen device',async()=>{
 await i18n.changeLanguage('en');const {fetcher,renderForm}=setup();
 const a='dev_01ARZ3NDEKTSV4RRFFQ69G5FAV', b='dev_01ARZ3NDEKTSV4RRFFQ69G5FAW', c='dev_01ARZ3NDEKTSV4RRFFQ69G5FAX';
 fetcher.mockImplementation((url:string)=>Promise.resolve(new Response(JSON.stringify({data:url.startsWith('/api/devices')?[{id:a,name:'A'},{id:b,name:'B'},{id:c,name:'C'}]:{...initial,defaultDeviceId:a},nextCursor:null}),{status:200})));
 const view=render(renderForm(initial));const select=await screen.findByLabelText('Default device') as HTMLSelectElement;await screen.findByRole('option',{name:'A'});
 view.rerender(renderForm({...initial,defaultDeviceId:a}));expect(select.value).toBe(a);
 fireEvent.change(select,{target:{value:b}});view.rerender(renderForm({...initial,defaultDeviceId:c}));
 expect(select.value).toBe(b);expect(screen.getByText(/default device changed elsewhere/i)).toBeInTheDocument();
 const form=select.closest('form')!;fireEvent.submit(form);expect(putBodies(fetcher)).toEqual([]);
 fireEvent.click(within(form).getByRole('button',{name:'Use latest value'}));expect(select.value).toBe(c);
 fireEvent.change(select,{target:{value:a}});fireEvent.click(within(form).getByRole('button',{name:'Save'}));
 await waitFor(()=>expect(putBodies(fetcher)).toEqual([{changes:{defaultDeviceId:a},expected:{defaultDeviceId:c}}]));
});

it('explains rejected validation separately from uncertain write outcomes',async()=>{
 await i18n.changeLanguage('en');const {fetcher,renderForm}=setup();
 fetcher.mockImplementation((_url:string,options?:RequestInit)=>Promise.resolve(options?.method==='PUT' ? new Response(JSON.stringify({error:{code:'BAD_REQUEST'}}),{status:400}) : new Response(JSON.stringify({data:[]}),{status:200})));
 render(renderForm(initial));fireEvent.change(screen.getByLabelText('Incoming ring timeout (seconds)'),{target:{value:'25'}});fireEvent.click(within(timingForm()).getByRole('button',{name:'Save'}));
 expect(await screen.findByText('The settings were rejected. Check the values and try again.')).toBeInTheDocument();
 expect(screen.queryByText(/save outcome may be unknown/i)).not.toBeInTheDocument();
});

it('allows clearing and entering a negative threshold without sending zero',async()=>{
 await i18n.changeLanguage('en');const {fetcher,renderForm}=setup();render(renderForm(initial));
 const input=screen.getByLabelText('Early media threshold (dBFS)') as HTMLInputElement;
 fireEvent.change(input,{target:{value:''}});expect(input.value).toBe('');fireEvent.submit(timingForm());expect(putBodies(fetcher)).toEqual([]);
 fireEvent.change(input,{target:{value:'-42.5'}});expect(input.value).toBe('-42.5');expect(input.validity.stepMismatch).toBe(false);fireEvent.click(within(timingForm()).getByRole('button',{name:'Save'}));
 await waitFor(()=>expect(putBodies(fetcher)).toEqual([{changes:{earlyMediaThresholdDbfs:-42.5},expected:{earlyMediaThresholdDbfs:-50}}]));
});

it('tells the user when settings committed but effects are uncertain',async()=>{
 await i18n.changeLanguage('en');const {fetcher,renderForm}=setup();
 fetcher.mockImplementation((_url:string,options?:RequestInit)=>Promise.resolve(options?.method==='PUT' ? new Response(JSON.stringify({error:{code:'SETTINGS_WRITE_COMMITTED_EFFECTS_UNKNOWN'}}),{status:500}) : new Response(JSON.stringify({data:[]}),{status:200})));
 render(renderForm(initial));fireEvent.change(screen.getByLabelText('Incoming ring timeout (seconds)'),{target:{value:'25'}});fireEvent.click(within(timingForm()).getByRole('button',{name:'Save'}));
 expect(await screen.findByText(/Settings were saved, but follow-up effects/)).toBeInTheDocument();
});
