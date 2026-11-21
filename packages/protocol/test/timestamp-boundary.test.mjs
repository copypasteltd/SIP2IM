import test from 'node:test';
import assert from 'node:assert/strict';
import {timestamp,devicePayloads} from '../dist/index.js';

test('timestamps fit JavaScript Date without changing ordinary values',()=>{
 for(const value of [0,1,1700000000000,8640000000000000]) assert.equal(timestamp.parse(value),value);
 for(const value of [-1,1.5,8640000000000001,Number.MAX_SAFE_INTEGER]) assert.equal(timestamp.safeParse(value).success,false);
});
test('status snapshots enforce the limit on nested probe timestamps',()=>{
 const probe={result:'ok',probedAt:0,detail:null};
 const probes=Object.fromEntries(['smsSend','smsReceive','dial','answer','hangup','dtmf','downlink','uplink','earlyMedia'].map(name=>[name,probe]));
 const payload={sims:[],capabilityLevel:'L1',probes,permissions:[]};
 assert.equal(devicePayloads['status.snapshot'].safeParse(payload).success,true);
 assert.equal(devicePayloads['status.snapshot'].safeParse({...payload,probes:{...probes,dial:{...probe,probedAt:8640000000000001}}}).success,false);
});
