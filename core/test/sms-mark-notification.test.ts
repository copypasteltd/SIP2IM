import {it,expect,vi} from 'vitest';
import {markSmsAndNotify} from '../src/sms/task-events.js';
it('keeps committed dispatch successful when publication fails',async()=>{
 const onError=vi.fn(); const mark=vi.fn(async()=>true); const notify=vi.fn(async()=>{throw Error('unavailable')});
 expect(await markSmsAndNotify(mark,notify,onError)).toBe(true);expect(onError).toHaveBeenCalledOnce();
});
