import {cleanup,fireEvent,render,screen} from '@testing-library/react';
import {afterEach,expect,it,vi} from 'vitest';
import {AppProviders} from '../../app/providers';
import {ComposeSms} from './compose-sms';
import i18n from '../../i18n';
afterEach(()=>{cleanup();vi.unstubAllGlobals();});
it('selects a device SIM before composing a new message',async()=>{await i18n.changeLanguage('en');vi.stubGlobal('fetch',vi.fn().mockResolvedValue(new Response(JSON.stringify({data:[{id:'dev',name:'Gateway',sims:[{id:'sim',slot:0,number:'+85212345678'}]}],nextCursor:null}),{status:200})));render(<AppProviders><ComposeSms/></AppProviders>);const select=await screen.findByLabelText('Sending SIM');fireEvent.change(select,{target:{value:'sim'}});fireEvent.change(screen.getByLabelText('Recipient number'),{target:{value:'123'}});fireEvent.click(screen.getByRole('button',{name:'Continue'}));expect(screen.getByLabelText('Message')).toBeInTheDocument();});
