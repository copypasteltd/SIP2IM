import test from 'node:test';
import assert from 'node:assert/strict';
import {createMonitor} from '../index.mjs';
test('fails closed without an explicit valid allowlist',()=>{for(const allowedSerials of [undefined,[],[''],['device with space']])assert.throws(()=>createMonitor({adb:async()=>'',report:async()=>{},allowedSerials}));});
test('ignores unrelated authorized and enrolled unauthorized devices',async()=>{const calls=[],reports=[];const m=createMonitor({allowedSerials:['enrolled','offline'],adb:async args=>{calls.push(args);if(args[0]==='devices')return 'List of devices attached\nenrolled device model:Good\nunrelated device model:Other\noffline unauthorized model:Bad\n';return '42';},report:async p=>reports.push(p),log:()=>{}});await m.poll();assert.deepEqual(reports.map(x=>x.serial),['enrolled']);assert.ok(calls.slice(1).every(x=>x[1]==='enrolled'));});
