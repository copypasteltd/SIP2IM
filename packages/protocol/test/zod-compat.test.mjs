import test from 'node:test';
import assert from 'node:assert/strict';
import { apiError, devicePayloads, adapterPayloads, adminRequests, platformMessageIdentity, timestamp } from '../dist/index.js';

test('integer fields retain Zod 3 finite integer acceptance', () => {
  const base = { token:'t', apkVersion:'1', apkCode:1, protocol:1, manufacturer:'m', model:'m', apiLevel:1, locale:'en' };
  for (const value of [-1e100, -9007199254740992, -1, 0, 1, 9007199254740992, 1e100]) {
    assert.equal(devicePayloads.hello.safeParse({...base, apkCode:value}).success, Number.isInteger(value));
    assert.equal(adminRequests.deviceBind.safeParse({code:'123456',manufacturer:'m',model:'m',apiLevel:value,apkVersion:'1',apkCode:1,locale:'en'}).success, Number.isInteger(value));
  }
  for (const value of [0.9999999999999999, 1.0000000000000002, 1.5, NaN, Infinity, -Infinity]) assert.equal(devicePayloads.hello.safeParse({...base, apkCode:value}).success, false);
  const capabilities = {login:true,sendMessage:true,receiveMessage:true,dial:true,receiveAudio:true,sendAudio:true,maxConcurrentCalls:9007199254740992};
  assert.equal(adapterPayloads.capabilities.safeParse(capabilities).success,true);
  assert.equal(timestamp.safeParse(9007199254740992).success,false);
});

test('objects strip unknown fields, strict identities reject extras, and nullable fields stay required', () => {
  const login = {username:'user',password:'pass'};
  assert.deepEqual(adminRequests.login.parse({...login,extra:true}), login);
  const identity = {version:1,accountId:'account',peer:{type:'user',id:'peer'},namespace:'server',messageId:'42'};
  assert.equal(platformMessageIdentity.safeParse({...identity,extra:true}).success,false);
  assert.equal(platformMessageIdentity.safeParse({...identity,peer:{...identity.peer,extra:true}}).success,false);
  const state = {state:'offline',selfId:null,alias:null,detail:null};
  assert.deepEqual(adapterPayloads['account.state'].parse(state),state);
  for (const key of ['selfId','alias','detail']) {
    const missing = {...state}; delete missing[key];
    assert.equal(adapterPayloads['account.state'].safeParse(missing).success,false);
    assert.equal(adapterPayloads['account.state'].safeParse({...state,[key]:undefined}).success,false);
  }
});

test('error details remain optional and nullable', () => {
  const error = {code:'BAD_REQUEST',message:'bad'};
  for (const extra of [{}, {details:undefined}, {details:null}, {details:{reason:'x'}}]) {
    const input = {error:{...error,...extra}};
    assert.deepEqual(apiError.parse(input),input);
  }
});
