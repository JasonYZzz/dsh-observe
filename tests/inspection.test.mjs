import {test} from 'node:test';
import assert from 'node:assert/strict';
import {inspect,contentPage} from '../lib/inspection.js';
import {inspectSerialize} from '../lib/policy.js';
import {fixtures} from './fixtures/rc2.mjs';
const run={startSeq:0,endSeq:6};
test('tool inspection pairs real arguments with its result and preserves source anchors',()=>{
 const result=inspect(fixtures.success,run,{kind:'tool',sourceSeq:3,endSeq:4,step:1});
 assert.equal(result.input[0].part,'arguments');assert.equal(result.output[0].seq,4);
 assert.ok(contentPage(fixtures.success[3],'arguments',undefined,0,1000).text.includes('example.txt'));
 assert.ok(contentPage(fixtures.success[4],'message',undefined,0,1000).text.includes('example'));
});
test('attempt inspection excludes its own response from request context and selects the retry result',()=>{
 const result=inspect(fixtures.retry,{startSeq:0,endSeq:8},{kind:'attempt',sourceSeq:6,step:1});
 assert.equal(result.inputSeq,6);assert.equal(result.output[0].seq,6);
 assert.equal(result.contextCount,0);
 assert.equal(result.configuration.provider,'fixture');
});
test('historical surface uses the request prefix rather than later compaction replacements',()=>{
 const result=inspect(fixtures.summary,{startSeq:0,endSeq:6},{kind:'attempt',sourceSeq:2,step:1});
 assert.equal(result.contextCount,0);
 assert.equal(result.contextStatus,'reconstructed');
});
test('inspection content pagination exposes later body text without releasing secrets',()=>{
 const event={seq:0,type:'tool/call',data:{arguments:JSON.stringify({apiKey:'credential-never-display',path:'example.txt',body:'a'.repeat(20000)+'last-page'})}};
 const first=contentPage(event,'arguments',undefined,0,16384);const last=contentPage(event,'arguments',undefined,first.nextOffset,16384);
 assert.ok(!first.text.includes('credential-never-display'));assert.ok(last.text.includes('last-page'));assert.equal(last.nextOffset,null);
});
test('inspection serialization bounds object graphs and never executes getters',()=>{
 const value={password:'never-display',get danger(){throw Error('getter executed');},body:'x'.repeat(5000)};
 const result=inspectSerialize(value,1000);assert.equal(result.truncated,true);assert.ok(result.text.includes('Accessor omitted'));assert.ok(!result.text.includes('never-display'));
});

test('real request fields include system, user input and effective tool definitions at the selected attempt',()=>{
 const result=inspect(fixtures.request,{startSeq:0,endSeq:9},{kind:'attempt',sourceSeq:5,step:1});
 assert.equal(result.contextCount,2);assert.deepEqual(result.context.map(item=>item.role),['system','user']);
 assert.equal(result.input[0].seq,4);assert.equal(result.input[0].preview.includes('fixture-secret-never-expose'),false);
 assert.equal(result.configuration.maxTokens,4096);assert.equal(result.toolCount,1);
 const tools=inspect(fixtures.request,{startSeq:0,endSeq:9},{kind:'attempt',sourceSeq:5,step:1},'tools');
 assert.equal(tools.tools[0].label,'read_file');
 assert.ok(contentPage(fixtures.request[2],'tool',0,0,16384).text.includes('parameters'));
});

test('compaction inspection shows its own summary without borrowing the preceding ordinary model request',()=>{
 const result=inspect(fixtures.summary,{startSeq:0,endSeq:10},{kind:'compaction',sourceSeq:7,summarySeq:8});
 assert.equal(result.output[0].seq,8);assert.equal(result.configuration.model,'summary-model');assert.equal(result.contextStatus,'unavailable');
});
test('configuration and JSON-encoded arguments preserve structure while redacting credentials',()=>{
 const events=structuredClone(fixtures.request);events[2].data.header.config.apiKey='never-show-key';
 const result=inspect(events,{startSeq:0,endSeq:9},{kind:'attempt',sourceSeq:5,step:1});
 assert.equal(result.configuration.apiKey,'[REDACTED]');
 const serialized=JSON.parse(inspectSerialize({arguments:'{"token":"never-show-token","path":"ok"}'}).text);
 assert.equal(typeof serialized.arguments,'string');assert.ok(!serialized.arguments.includes('never-show-token'));
});

test('a tool following retries uses the successful request boundary, including intervening input',()=>{
 const correction={type:'user/message',data:{id:'retry-input',role:'user',source:{kind:'user'},content:[{type:'text',text:'Retry with this correction'}]},surfaceOp:'append',time:1055};
 const events=[...fixtures.retry.slice(0,6),correction,...fixtures.success.slice(2)].map((event,seq)=>({...event,seq}));
 const result=inspect(events,{startSeq:0,endSeq:11},{kind:'tool',sourceSeq:8,endSeq:9,step:1});
 assert.equal(result.inputSeq,7);assert.equal(result.context.find(item=>item.seq===6).role,'user');
 assert.equal(result.output[0].seq,9);
});

test('message badges distinguish producer context from human input without changing protocol roles',()=>{
 const result=inspect(fixtures.classified,{startSeq:0,endSeq:12},{kind:'attempt',sourceSeq:8,step:1});
 assert.deepEqual(result.input.map(item=>item.seq),[7]);
 assert.deepEqual(result.injections.map(item=>[item.category,item.role,item.sourceKind]),[
  ['context','user','user-approval'],['context','user','runtime-context'],['context','developer','skill-catalog']]);
 assert.deepEqual(result.categoryCounts,{system:1,context:3,user:1});
 assert.equal(result.injections[0].form,'notice');assert.equal(result.output[0].category,'assistant');
 const tool=inspect(fixtures.classified,{startSeq:0,endSeq:12},{kind:'tool',sourceSeq:9,endSeq:10,step:1});
 assert.equal(tool.input[0].category,'tool');assert.equal(tool.output[0].category,'tool');
});
test('unknown or missing producer kinds never become human input by guessing from text',()=>{
 for(const source of [{kind:'future-context-producer'},{}]){
  const events=structuredClone(fixtures.request);events[4].data.source=source;
  const result=inspect(events,{startSeq:0,endSeq:9},{kind:'attempt',sourceSeq:5,step:1});
  assert.equal(result.input.length,0);assert.equal(result.injections[0].category,'context');
 }
});
test('semantic context filters apply before pagination and keep complete category counts',()=>{
 const events=structuredClone(fixtures.classified);
 const copies=Array.from({length:35},(_,i)=>({...structuredClone(events[5]),data:{...structuredClone(events[5].data),id:`runtime-${i}`}}));
 events.splice(7,0,...copies);events.forEach((event,seq)=>event.seq=seq);
 const result=inspect(events,{startSeq:0,endSeq:47},{kind:'attempt',sourceSeq:43,step:1},'context',30,30,'context');
 assert.equal(result.contextCount,40);assert.equal(result.contextFilteredCount,38);
 assert.equal(result.context.length,8);assert.ok(result.context.every(item=>item.category==='context'));
 assert.deepEqual(result.categoryCounts,{system:1,context:38,user:1});
 const user=inspect(events,{startSeq:0,endSeq:47},{kind:'attempt',sourceSeq:43,step:1},'context',0,30,'user');
 assert.equal(user.context.length,1);assert.equal(user.contextFilteredCount,1);
});
