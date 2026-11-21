import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { AppProviders } from '../../app/providers';
import { MemoryRouter } from 'react-router-dom';
import type { DeviceDetail } from '../../api/endpoints';
import i18n from '../../i18n';
import { DeviceActions } from './device-actions';

const device = {id:'dev_1',name:'Original',enabled:true} as DeviceDetail;
const response = (data: unknown) => new Response(JSON.stringify({data}),{status:200});
afterEach(()=>{cleanup();vi.unstubAllGlobals();});
function renderDevice(value: DeviceDetail) {return <MemoryRouter><AppProviders><DeviceActions device={value}/></AppProviders></MemoryRouter>;}
it('refreshes clean names and blocks dirty conflicts until explicitly reloaded',async()=>{
  await i18n.changeLanguage('en');
  const view=render(renderDevice(device));const input=screen.getAllByLabelText('Device name')[0];
  view.rerender(renderDevice({...device,name:'Refetched'}));expect(input).toHaveValue('Refetched');
  fireEvent.change(input,{target:{value:'My edit'}});
  view.rerender(renderDevice({...device,name:'Other admin'}));
  expect(input).toHaveValue('My edit');expect(screen.getByRole('alert')).toHaveTextContent('changed on the server');
  expect(screen.getByRole('button',{name:'Save'})).toBeDisabled();
  fireEvent.change(input,{target:{value:'Refetched'}});
  expect(input).toHaveValue('Refetched');
  expect(screen.getByRole('button',{name:'Save'})).toBeDisabled();
  expect(screen.getByRole('alert')).toHaveTextContent('changed on the server');
  fireEvent.click(screen.getByRole('button',{name:'Reload current value'}));expect(input).toHaveValue('Other admin');
});
it('does not write when the latest server name differs or cannot be fetched',async()=>{
  await i18n.changeLanguage('en');
  const fetchMock=vi.fn().mockResolvedValue(response({...device,name:'Other admin'}));vi.stubGlobal('fetch',fetchMock);
  render(renderDevice(device));fireEvent.change(screen.getAllByLabelText('Device name')[0],{target:{value:'My edit'}});fireEvent.click(screen.getByRole('button',{name:'Save'}));
  expect(await screen.findByRole('alert')).toHaveTextContent('changed on the server');expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(screen.getAllByLabelText('Device name')[0]).toHaveValue('My edit');
});
it('ignores a stale preflight result after a newer update',async()=>{
  await i18n.changeLanguage('en');
  let resolveRead!: (value: Response) => void;
  const fetchMock=vi.fn().mockImplementation(()=>new Promise<Response>(resolve=>{resolveRead=resolve;}));
  vi.stubGlobal('fetch',fetchMock);
  const view=render(renderDevice(device));
  fireEvent.change(screen.getAllByLabelText('Device name')[0],{target:{value:'My edit'}});
  fireEvent.click(screen.getByRole('button',{name:'Save'}));
  await waitFor(()=>expect(fetchMock).toHaveBeenCalledTimes(1));
  view.rerender(renderDevice({...device,name:'Newer'}));
  await act(async()=>{resolveRead(response({...device,name:'Older'}));});
  await waitFor(()=>expect(screen.getByRole('button',{name:'Reload current value'})).toBeEnabled());
  fireEvent.click(screen.getByRole('button',{name:'Reload current value'}));
  expect(screen.getAllByLabelText('Device name')[0]).toHaveValue('Newer');
  expect(fetchMock).toHaveBeenCalledTimes(1);
});
it('acknowledges a matching observed name while the save is pending',async()=>{
  await i18n.changeLanguage('en');
  let finish!: (value: Response) => void;
  const fetchMock=vi.fn().mockResolvedValueOnce(response(device)).mockImplementationOnce(()=>new Promise<Response>(resolve=>{finish=resolve;}));
  vi.stubGlobal('fetch',fetchMock);
  const view=render(renderDevice(device));
  fireEvent.change(screen.getAllByLabelText('Device name')[0],{target:{value:'Saved'}});
  fireEvent.click(screen.getByRole('button',{name:'Save'}));
  await waitFor(()=>expect(fetchMock).toHaveBeenCalledTimes(2));
  view.rerender(renderDevice({...device,name:'Saved'}));
  await act(async()=>{finish(response({...device,name:'Saved'}));});
  await waitFor(()=>expect(screen.queryByRole('alert')).not.toBeInTheDocument());
  expect(screen.getAllByLabelText('Device name')[0]).toHaveValue('Saved');
  expect(screen.getByRole('button',{name:'Save'})).toBeEnabled();
});
it('does not erase a newer name when a delayed save succeeds',async()=>{
  await i18n.changeLanguage('en');
  let finish!: (value: Response) => void;
  const fetchMock=vi.fn().mockResolvedValueOnce(response(device)).mockImplementationOnce(()=>new Promise<Response>(resolve=>{finish=resolve;}));
  vi.stubGlobal('fetch',fetchMock);
  const view=render(renderDevice(device));
  fireEvent.change(screen.getAllByLabelText('Device name')[0],{target:{value:'Saved'}});
  fireEvent.click(screen.getByRole('button',{name:'Save'}));
  await waitFor(()=>expect(fetchMock).toHaveBeenCalledTimes(2));
  view.rerender(renderDevice({...device,name:'Newer'}));
  await act(async()=>{finish(response({...device,name:'Saved'}));});
  await waitFor(()=>expect(screen.getByRole('button',{name:'Reload current value'})).toBeEnabled());
  expect(screen.getAllByLabelText('Device name')[0]).toHaveValue('Saved');
  fireEvent.click(screen.getByRole('button',{name:'Reload current value'}));
  expect(screen.getAllByLabelText('Device name')[0]).toHaveValue('Newer');
});
it('retains the draft when a concurrent rename wins after preflight',async()=>{
 await i18n.changeLanguage('en');
 const fetchMock=vi.fn().mockResolvedValueOnce(response(device)).mockResolvedValueOnce(new Response(JSON.stringify({error:{code:'CONFLICT'}}),{status:409})).mockResolvedValueOnce(response({...device,name:'Other admin'}));vi.stubGlobal('fetch',fetchMock);
 render(renderDevice(device));fireEvent.change(screen.getAllByLabelText('Device name')[0],{target:{value:'My edit'}});fireEvent.click(screen.getByRole('button',{name:'Save'}));
 expect(await screen.findByRole('alert')).toHaveTextContent('changed on the server');
 expect(screen.getAllByLabelText('Device name')[0]).toHaveValue('My edit');
 expect(fetchMock.mock.calls[1][0]).toContain('/api/devices/dev_1/name');
 expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({name:'My edit',expectedName:'Original'});
 fireEvent.click(screen.getByRole('button',{name:'Reload current value'}));expect(screen.getAllByLabelText('Device name')[0]).toHaveValue('Other admin');
});
it('explains an unavailable rename endpoint without a legacy fallback',async()=>{
 await i18n.changeLanguage('en');const fetchMock=vi.fn().mockResolvedValueOnce(response(device)).mockResolvedValueOnce(new Response(JSON.stringify({error:{code:'NOT_FOUND'}}),{status:404}));vi.stubGlobal('fetch',fetchMock);
 render(renderDevice(device));fireEvent.change(screen.getAllByLabelText('Device name')[0],{target:{value:'My edit'}});fireEvent.click(screen.getByRole('button',{name:'Save'}));
 expect(await screen.findByRole('alert')).toHaveTextContent('server may need an upgrade');expect(fetchMock).toHaveBeenCalledTimes(2);expect(screen.getAllByLabelText('Device name')[0]).toHaveValue('My edit');
});
it('preserves the conflict error when refreshing the current value fails',async()=>{
 await i18n.changeLanguage('en');const fetchMock=vi.fn().mockResolvedValueOnce(response(device)).mockResolvedValueOnce(new Response(JSON.stringify({error:{code:'CONFLICT'}}),{status:409})).mockRejectedValueOnce(new Error('offline'));vi.stubGlobal('fetch',fetchMock);
 render(renderDevice(device));fireEvent.change(screen.getAllByLabelText('Device name')[0],{target:{value:'My edit'}});fireEvent.click(screen.getByRole('button',{name:'Save'}));
 expect(await screen.findByRole('alert')).toHaveTextContent('CONFLICT');expect(screen.getAllByLabelText('Device name')[0]).toHaveValue('My edit');
});
it('keeps input and avoids writing when the preflight fails',async()=>{
  await i18n.changeLanguage('en');
  const fetchMock=vi.fn().mockRejectedValue(new Error('offline'));vi.stubGlobal('fetch',fetchMock);
  render(renderDevice(device));fireEvent.change(screen.getAllByLabelText('Device name')[0],{target:{value:'My edit'}});fireEvent.click(screen.getByRole('button',{name:'Save'}));
  await waitFor(()=>expect(screen.getByRole('alert')).toBeInTheDocument());expect(fetchMock).toHaveBeenCalledTimes(1);expect(screen.getAllByLabelText('Device name')[0]).toHaveValue('My edit');
});
