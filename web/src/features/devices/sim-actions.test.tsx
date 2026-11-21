import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {afterEach,expect,it,vi} from 'vitest';
import {AppProviders} from '../../app/providers';
import {SimActions} from './sim-actions';
import i18n from '../../i18n';
const sim={id:'sim_1',slot:0,number:null,carrier:null,state:'ready',numberSource:null,needsReview:true};
afterEach(()=>{cleanup();vi.unstubAllGlobals();});
it('sends nullable baseline and preserves the draft on a server conflict',async()=>{
 await i18n.changeLanguage('en');const fetchMock=vi.fn().mockResolvedValue(new Response(JSON.stringify({error:{code:'CONFLICT',details:{currentNumber:'222'}}}),{status:409}));vi.stubGlobal('fetch',fetchMock);
 render(<AppProviders><SimActions sim={sim} deviceId="dev_1"/></AppProviders>);
 fireEvent.change(screen.getByLabelText('SIM number'),{target:{value:'333'}});fireEvent.click(screen.getByRole('button',{name:'Save number'}));
 expect(await screen.findByRole('alert')).toHaveTextContent('changed on the server');expect(screen.getByLabelText('SIM number')).toHaveValue('333');
 expect(fetchMock.mock.calls[0][0]).toBe('/api/sims/sim_1/number/conditional');expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({number:'333',expectedNumber:null});
 fireEvent.click(screen.getByRole('button',{name:'Reload current value'}));expect(screen.getByLabelText('SIM number')).toHaveValue('222');
});
it('uses the canonical number returned by the server',async()=>{
 await i18n.changeLanguage('en');vi.stubGlobal('fetch',vi.fn().mockResolvedValue(new Response(JSON.stringify({data:{number:'+85223456789'}}),{status:200})));
 render(<AppProviders><SimActions sim={{...sim,number:'111'}} deviceId="dev_1"/></AppProviders>);
 fireEvent.change(screen.getByLabelText('SIM number'),{target:{value:'2345 6789'}});fireEvent.click(screen.getByRole('button',{name:'Save number'}));
 await waitFor(()=>expect(screen.getByLabelText('SIM number')).toHaveValue('+85223456789'));
});
it('keeps a newer server observation when a save response arrives late',async()=>{
 await i18n.changeLanguage('en');let finish!:(r:Response)=>void;vi.stubGlobal('fetch',vi.fn().mockImplementation(()=>new Promise<Response>(resolve=>{finish=resolve;})));
 const view=render(<AppProviders><SimActions sim={{...sim,number:'111'}} deviceId="dev_1"/></AppProviders>);
 fireEvent.change(screen.getByLabelText('SIM number'),{target:{value:'222'}});fireEvent.click(screen.getByRole('button',{name:'Save number'}));
 await waitFor(()=>expect(finish).toBeDefined());view.rerender(<AppProviders><SimActions sim={{...sim,number:'333'}} deviceId="dev_1"/></AppProviders>);
 finish(new Response(JSON.stringify({data:{number:'222'}}),{status:200}));
 expect(await screen.findByRole('button',{name:'Reload current value'})).toBeEnabled();expect(screen.getByLabelText('SIM number')).toHaveValue('222');
 fireEvent.click(screen.getByRole('button',{name:'Reload current value'}));expect(screen.getByLabelText('SIM number')).toHaveValue('333');
});
