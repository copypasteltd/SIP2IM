import {cleanup,render,screen} from '@testing-library/react';
import {afterEach,expect,it,vi} from 'vitest';
import {Countdown} from './countdown';
import i18n from '../../i18n';
afterEach(()=>{cleanup();vi.useRealTimers();});
it('shows expired once the deadline passes',async()=>{await i18n.changeLanguage('en');vi.useFakeTimers();vi.setSystemTime(10000);render(<Countdown expiresAt={9000}/>);expect(screen.getByText('Expired')).toBeInTheDocument();});
