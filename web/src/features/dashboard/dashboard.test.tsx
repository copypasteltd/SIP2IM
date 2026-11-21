import {cleanup,render,screen,within} from '@testing-library/react';
import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
import {MemoryRouter} from 'react-router-dom';
import {afterEach,expect,it,vi} from 'vitest';
import {Dashboard} from './dashboard';
import {useConnection} from '../../realtime/use-admin-socket';
import i18n from '../../i18n';
const data={devices:{total:4,online:3,offline:1,paused:0,byLevel:{L1:0,L2:0,L3:1,L4:2,L5:1}},sims:{total:6,ready:5,numberKnown:4,needsReview:1},capability:{smsReady:2,callReady:5,inCall:1},channels:[{platform:'qq',state:'logged_in',paired:true,voiceVerified:false,busy:false,isInbound:true}],alerts:{open:2,critical:1}};
afterEach(()=>{cleanup();vi.unstubAllGlobals();useConnection.getState().setState('disconnected');});
function setup(){const client=new QueryClient({defaultOptions:{queries:{retry:false}}});render(<QueryClientProvider client={client}><MemoryRouter><Dashboard/></MemoryRouter></QueryClientProvider>);}
it('renders fetched metrics and leaves missing channels unknown',async()=>{await i18n.changeLanguage('en');useConnection.getState().setState('connected');vi.stubGlobal('fetch',vi.fn().mockImplementation(()=>Promise.resolve(new Response(JSON.stringify({data}),{status:200}))));setup();const tile=(await screen.findByRole('heading',{name:'Total devices'})).closest('article')!;expect(within(tile).getByText('4')).toBeInTheDocument();expect(screen.getByText('Signed in')).toBeInTheDocument();expect(screen.getAllByText('Unknown').length).toBeGreaterThan(0);});
it('does not present old counts as current while disconnected',async()=>{await i18n.changeLanguage('en');useConnection.getState().setState('disconnected');vi.stubGlobal('fetch',vi.fn().mockImplementation(()=>Promise.resolve(new Response(JSON.stringify({data}),{status:200}))));setup();expect(await screen.findByText('Data is stale')).toBeInTheDocument();const tile=screen.getByRole('heading',{name:'Total devices'}).closest('article')!;expect(within(tile).getByText('—')).toBeInTheDocument();expect(within(tile).queryByText('4')).not.toBeInTheDocument();});
it('shows an error when the dashboard request fails',async()=>{await i18n.changeLanguage('en');vi.stubGlobal('fetch',vi.fn().mockRejectedValue(new Error('offline')));setup();expect(await screen.findByRole('alert')).toHaveTextContent('Unable to load data');});
