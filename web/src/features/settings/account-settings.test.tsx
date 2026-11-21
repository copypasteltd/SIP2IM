import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {afterEach,expect,it,vi} from 'vitest';
import {AppProviders} from '../../app/providers';
import {AccountSettings} from './account-settings';
import i18n from '../../i18n';
afterEach(()=>{cleanup();vi.unstubAllGlobals();});
it('submits password change and clears entered secrets on success',async()=>{await i18n.changeLanguage('en');const f=vi.fn().mockResolvedValue(new Response(JSON.stringify({data:{}}),{status:200}));vi.stubGlobal('fetch',f);render(<AppProviders><AccountSettings/></AppProviders>);fireEvent.change(screen.getByLabelText('Current password'),{target:{value:'old-password'}});fireEvent.change(screen.getByLabelText('New password (at least 10 characters)'),{target:{value:'new-password'}});fireEvent.click(screen.getAllByRole('button',{name:'Save'})[1]);await waitFor(()=>expect(f).toHaveBeenCalled());expect(f.mock.calls[0][0]).toBe('/api/auth/password');expect(JSON.parse(f.mock.calls[0][1].body)).toEqual({oldPassword:'old-password',newPassword:'new-password'});expect(await screen.findByText('Saved')).toBeInTheDocument();expect(screen.getByLabelText('Current password')).toHaveValue('');});
