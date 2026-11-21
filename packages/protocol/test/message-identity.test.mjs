import test from 'node:test';
import assert from 'node:assert/strict';
import { platformMessageIdentity, parseAdapterMessage } from '../dist/index.js';
const identity={version:1,accountId:'account',peer:{type:'user',id:'peer'},namespace:'server',messageId:'42'};
test('identity validates bounded opaque components and exact version',()=>{
 assert.deepEqual(platformMessageIdentity.parse(identity),identity);
 for(const bad of ['', '0',' ', ' a','a\u0000','x'.repeat(257)]) for(const field of ['accountId','messageId']) assert.equal(platformMessageIdentity.safeParse({...identity,[field]:bad}).success,false);
 for(const bad of ['', '0','a\n','x'.repeat(257)]) assert.equal(platformMessageIdentity.safeParse({...identity,peer:{type:'user',id:bad}}).success,false);
 for(const bad of [{...identity,version:2},{...identity,namespace:'temporary'},{...identity,peer:{...identity.peer,type:'unknown'}},{...identity,extra:true}]) assert.equal(platformMessageIdentity.safeParse(bad).success,false);
});
test('legacy wire payload remains readable and scoped identity round trips',()=>{
 const payload={platformMessageId:'42',senderId:'peer',senderName:null,chatType:'private',forwarded:false,isContact:null,text:'hi',ts:1};
 const envelope={v:1,type:'message.received',id:'ipc_01ARZ3NDEKTSV4RRFFQ69G5FAV',ts:1,payload};
 assert.deepEqual(parseAdapterMessage(envelope),envelope);
 const scoped={...envelope,payload:{...payload,identity}};
 assert.deepEqual(parseAdapterMessage(scoped),scoped);
 assert.throws(()=>parseAdapterMessage({...envelope,payload:{...payload,identity:{...identity,version:2}}}));
});
