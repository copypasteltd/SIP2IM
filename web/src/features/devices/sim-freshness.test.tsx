import {act, cleanup, render, screen, within} from '@testing-library/react';
import {afterEach, expect, it, vi} from 'vitest';
import {Slots} from './devices';
import {useConnection} from '../../realtime/use-admin-socket';
import i18n from '../../i18n';

const now=10_000_000;
const sim={id:'s',slot:0,number:null,carrier:null,state:'ready',numberSource:null,needsReview:false};
afterEach(()=>{cleanup();vi.useRealTimers();useConnection.getState().setState('disconnected');});
it('shows only currently observed SIM states and expires them while mounted',async()=>{
 await i18n.changeLanguage('en'); vi.useFakeTimers(); vi.setSystemTime(now); useConnection.getState().setState('connected');
 const timestamps=[now-7200000,now-7200001,now+1,null,NaN,now];
 render(<Slots sims={timestamps.map((lastSeenAt,slot)=>({...sim,id:String(slot),slot,lastSeenAt}))}/>);
 const rows=screen.getAllByRole('listitem');
 expect(within(rows[0]!).getByText('Ready')).toBeInTheDocument();
 for(const row of rows.slice(1,5)) expect(within(row).queryByText('Ready')).not.toBeInTheDocument();
 expect(within(rows[5]!).getByText('Ready')).toBeInTheDocument();
 act(()=>{vi.advanceTimersByTime(1000);});
 expect(within(rows[0]!).queryByText('Ready')).not.toBeInTheDocument();
});
it('renders a newly received observation using the current clock',async()=>{
 await i18n.changeLanguage('en'); vi.useFakeTimers(); vi.setSystemTime(now); useConnection.getState().setState('connected');
 const view=render(<Slots sims={[{...sim,lastSeenAt:now}]}/>);
 act(()=>{vi.setSystemTime(now+60000);});
 view.rerender(<Slots sims={[{...sim,lastSeenAt:now+60000}]}/>);
 expect(screen.getByText('Ready')).toBeInTheDocument();
});
