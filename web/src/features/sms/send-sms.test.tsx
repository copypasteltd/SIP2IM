import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useSession } from '../../stores/session';
import { AppProviders } from '../../app/providers';
import { SendSms } from './send-sms';
import i18n from '../../i18n';
beforeEach(()=>useSession.getState().setSession({username:'admin',token:'fake',expiresAt:Date.now()+60000}));
afterEach(()=>{cleanup();sessionStorage.clear();vi.unstubAllGlobals();useSession.getState().setSession(null);});
it('reuses idempotency key after an uncertain send failure',async()=>{await i18n.changeLanguage('en');const fetchMock=vi.fn().mockRejectedValueOnce(new Error('network')).mockResolvedValueOnce(new Response(JSON.stringify({data:{id:'m1',simId:'sim_1',body:'hello',peer:'123',direction:'out',deviceId:'dev',occurredAt:1,task:{id:'task',state:'queued',updatedAt:1}}}),{status:200}));vi.stubGlobal('fetch',fetchMock);render(<AppProviders><SendSms simId="sim_1" peer="123"/></AppProviders>);fireEvent.change(screen.getByLabelText('Message'),{target:{value:'hello'}});fireEvent.click(screen.getByRole('button',{name:'Send message'}));expect(await screen.findByRole('alert')).toBeInTheDocument();fireEvent.click(screen.getByRole('button',{name:'Resume pending message'}));await waitFor(()=>expect(fetchMock).toHaveBeenCalledTimes(2));const first=fetchMock.mock.calls[0][1];const second=fetchMock.mock.calls[1][1];expect(first.headers.get('Idempotency-Key')).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);expect(second.headers.get('Idempotency-Key')).toBe(first.headers.get('Idempotency-Key'));expect(JSON.parse(first.body)).toEqual({simId:'sim_1',to:'123',body:'hello'});});

it('allows correction after a definite validation rejection',async()=>{await i18n.changeLanguage('en');const mock=vi.fn().mockResolvedValue(new Response(JSON.stringify({error:{code:'BAD_REQUEST'}}),{status:400}));const lock=vi.fn();vi.stubGlobal('fetch',mock);render(<AppProviders><SendSms simId="sim_1" peer="123" onPendingChange={lock}/></AppProviders>);fireEvent.change(screen.getByLabelText('Message'),{target:{value:'invalid'}});fireEvent.click(screen.getByRole('button',{name:'Send message'}));expect(await screen.findByRole('alert')).toBeInTheDocument();expect(screen.getByLabelText('Message')).toBeEnabled();expect(lock).toHaveBeenLastCalledWith(false);});
it.each([400, 401, 409])('keeps an unknown intent when a later request returns %s', async status => {
  await i18n.changeLanguage('en');
  const code = status === 401 ? 'UNAUTHORIZED' : status === 409 ? 'CONFLICT' : 'BAD_REQUEST';
  const record = { id: 'm', simId: 'sim_1', body: 'hello', peer: '123', direction: 'out', deviceId: 'dev',
    occurredAt: 1, task: { id: 'task', state: 'queued', updatedAt: 1 } };
  const fetchMock = vi.fn()
    .mockRejectedValueOnce(new Error('offline'))
    .mockResolvedValueOnce(new Response(JSON.stringify({ error: { code } }), { status }))
    .mockResolvedValueOnce(new Response(JSON.stringify({ data: record }), { status: 200 }));
  vi.stubGlobal('fetch', fetchMock);
  const initial = render(<AppProviders><SendSms simId="sim_1" peer="123" /></AppProviders>);
  fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'hello' } });
  fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
  await screen.findByRole('alert');
  const saved = sessionStorage.getItem('voip.sms.pending.v1');
  expect(saved).not.toBeNull();
  initial.unmount();
  render(<AppProviders><SendSms simId="sim_1" peer="123" recovery /></AppProviders>);
  expect(screen.getByLabelText('Message')).toHaveValue('hello');
  expect(fetchMock).toHaveBeenCalledTimes(1);
  const resume = () => screen.getByRole('button', { name: 'Resume pending message' });
  fireEvent.click(resume());
  if (status === 401) {
    await waitFor(() => expect(useSession.getState().session).toBeNull());
    expect(screen.queryByRole('button', { name: 'Resume pending message' })).not.toBeInTheDocument();
  } else {
    expect(await screen.findByRole('alert')).toBeInTheDocument();
  }
  expect(sessionStorage.getItem('voip.sms.pending.v1')).toBe(saved);
  expect(fetchMock).toHaveBeenCalledTimes(2);
  if (status === 401) {
    act(() => useSession.getState().setSession({ username: 'admin', token: 'replacement', expiresAt: Date.now() + 60_000 }));
  }
  await waitFor(() => expect(resume()).toBeEnabled());
  fireEvent.click(resume());
  await waitFor(() => expect(sessionStorage.getItem('voip.sms.pending.v1')).toBeNull());
  const requests = fetchMock.mock.calls.map(call => call[1]);
  expect(requests).toHaveLength(3);
  expect(requests.map(item => item.headers.get('Idempotency-Key'))).toEqual(Array(3).fill(requests[0].headers.get('Idempotency-Key')));
  expect(requests.map(item => item.body)).toEqual(Array(3).fill(requests[0].body));
  if (status === 401) expect(requests[2].headers.get('Authorization')).toBe('Bearer replacement');
});
it('does not send when storage is unavailable',async()=>{await i18n.changeLanguage('en');const mock=vi.fn();vi.stubGlobal('fetch',mock);vi.spyOn(Storage.prototype,'setItem').mockImplementation(()=>{throw new Error('blocked');});render(<AppProviders><SendSms simId="sim_1" peer="123"/></AppProviders>);fireEvent.change(screen.getByLabelText('Message'),{target:{value:'hello'}});fireEvent.click(screen.getByRole('button',{name:'Send message'}));expect(await screen.findByText('Storage is unavailable or invalid. Sending is disabled; contact your administrator to reconcile the pending message.')).toBeInTheDocument();expect(mock).not.toHaveBeenCalled();vi.restoreAllMocks();});
it('retains the request when success response does not match',async()=>{await i18n.changeLanguage('en');const mock=vi.fn().mockResolvedValue(new Response(JSON.stringify({data:{id:'m',simId:'different',peer:'123',body:'hello',direction:'out',deviceId:'dev',occurredAt:1,task:{id:'task',state:'queued',updatedAt:1}}}),{status:200}));vi.stubGlobal('fetch',mock);render(<AppProviders><SendSms simId="sim_1" peer="123"/></AppProviders>);fireEvent.change(screen.getByLabelText('Message'),{target:{value:'hello'}});fireEvent.click(screen.getByRole('button',{name:'Send message'}));await screen.findByRole('alert');expect(sessionStorage.getItem('voip.sms.pending.v1')).not.toBeNull();expect(screen.getByRole('button',{name:'Resume pending message'})).toBeEnabled();});
it('does not persist or send oversized text',async()=>{await i18n.changeLanguage('en');const mock=vi.fn();vi.stubGlobal('fetch',mock);render(<AppProviders><SendSms simId="sim_1" peer="123"/></AppProviders>);fireEvent.change(screen.getByLabelText('Message'),{target:{value:'x'.repeat(10001)}});fireEvent.click(screen.getByRole('button',{name:'Send message'}));expect(mock).not.toHaveBeenCalled();expect(sessionStorage.getItem('voip.sms.pending.v1')).toBeNull();});
it('keeps the saved intent and disabled UI if removal fails',async()=>{await i18n.changeLanguage('en');vi.stubGlobal('fetch',vi.fn().mockResolvedValue(new Response(JSON.stringify({data:{id:'m',simId:'sim_1',body:'hello',peer:'123',direction:'out',deviceId:'dev',occurredAt:1,task:{id:'task',state:'queued',updatedAt:1}}}),{status:200})));const remove=vi.spyOn(Storage.prototype,'removeItem').mockImplementation(()=>{throw new Error('blocked');});render(<AppProviders><SendSms simId="sim_1" peer="123"/></AppProviders>);fireEvent.change(screen.getByLabelText('Message'),{target:{value:'hello'}});fireEvent.click(screen.getByRole('button',{name:'Send message'}));expect(await screen.findByText('Storage is unavailable or invalid. Sending is disabled; contact your administrator to reconcile the pending message.')).toBeInTheDocument();expect(sessionStorage.getItem('voip.sms.pending.v1')).not.toBeNull();expect(screen.getByRole('button',{name:'Resume pending message'})).toBeDisabled();remove.mockRestore();});
it.each(['absent','found','mismatch'])('checks pending intent without sending: %s',async mode=>{await i18n.changeLanguage('en');const record={id:'m',simId:mode==='mismatch'?'wrong':'sim_1',body:'hello',peer:'123',direction:'out',deviceId:'dev',occurredAt:1,task:{id:'task',state:'unknown',updatedAt:1}};const mock=vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(new Response(JSON.stringify({data:mode==='absent'?null:record}),{status:200}));vi.stubGlobal('fetch',mock);render(<AppProviders><SendSms simId="sim_1" peer="123"/></AppProviders>);fireEvent.change(screen.getByLabelText('Message'),{target:{value:'hello'}});fireEvent.click(screen.getByRole('button',{name:'Send message'}));await screen.findByText(/The result may be unknown/);const before=sessionStorage.getItem('voip.sms.pending.v1');fireEvent.click(screen.getByRole('button',{name:'Check status'}));if(mode==='absent') expect(await screen.findByText(/original request may still complete/)).toBeInTheDocument();else if(mode==='found'){expect(await screen.findByText(/Task state: unknown/)).toBeInTheDocument();fireEvent.click(screen.getByRole('button',{name:'Acknowledge record'}));expect(sessionStorage.getItem('voip.sms.pending.v1')).toBeNull();}else expect(await screen.findByText(/Could not verify/)).toBeInTheDocument();if(mode!=='found')expect(sessionStorage.getItem('voip.sms.pending.v1')).toBe(before);expect(mock.mock.calls[1][0]).toBe('/api/sms/idempotency');expect(mock.mock.calls[1][1].method).toBe('GET');expect(mock.mock.calls[1][1].headers.get('Idempotency-Key')).toBe(mock.mock.calls[0][1].headers.get('Idempotency-Key'));expect(mock).toHaveBeenCalledTimes(2);});
it('preserves pending intent if account changes during send',async()=>{await i18n.changeLanguage('en');let finish!:(r:Response)=>void;vi.stubGlobal('fetch',vi.fn(()=>new Promise<Response>(resolve=>{finish=resolve;})));render(<AppProviders><SendSms simId="sim_1" peer="123"/></AppProviders>);fireEvent.change(screen.getByLabelText('Message'),{target:{value:'hello'}});fireEvent.click(screen.getByRole('button',{name:'Send message'}));await waitFor(()=>expect(finish).toBeDefined());const saved=sessionStorage.getItem('voip.sms.pending.v1');useSession.getState().setSession({username:'other',token:'different',expiresAt:Date.now()+60000});finish(new Response(JSON.stringify({data:{id:'m',simId:'sim_1',body:'hello',peer:'123',direction:'out',deviceId:'dev',occurredAt:1,task:{id:'task',state:'queued',updatedAt:1}}}),{status:200}));await waitFor(()=>expect(screen.getByText(/Resolve the pending message/)).toBeInTheDocument());expect(sessionStorage.getItem('voip.sms.pending.v1')).toBe(saved);});
it('ignores lookup response after recipient changes',async()=>{await i18n.changeLanguage('en');let finish!:(r:Response)=>void;const mock=vi.fn().mockRejectedValueOnce(new Error('offline')).mockImplementationOnce(()=>new Promise<Response>(resolve=>{finish=resolve;}));vi.stubGlobal('fetch',mock);const ui=render(<AppProviders><SendSms simId="sim_1" peer="123"/></AppProviders>);fireEvent.change(screen.getByLabelText('Message'),{target:{value:'hello'}});fireEvent.click(screen.getByRole('button',{name:'Send message'}));await screen.findByText(/The result may be unknown/);fireEvent.click(screen.getByRole('button',{name:'Check status'}));await waitFor(()=>expect(finish).toBeDefined());ui.rerender(<AppProviders><SendSms simId="sim_1" peer="456"/></AppProviders>);finish(new Response(JSON.stringify({data:{id:'m',simId:'sim_1',body:'hello',peer:'123',direction:'out',deviceId:'dev',occurredAt:1,task:{id:'task',state:'queued',updatedAt:1}}}),{status:200}));await waitFor(()=>expect(screen.getByText(/Resolve the pending message/)).toBeInTheDocument());expect(screen.queryByRole('button',{name:'Acknowledge record'})).not.toBeInTheDocument();expect(sessionStorage.getItem('voip.sms.pending.v1')).not.toBeNull();});
