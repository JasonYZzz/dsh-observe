import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHandler } from '../lib/query.js';
const signal = new AbortController().signal;
const handle = createHandler({ health: async () => ({ database: { status: 'ready' } }) });
test('health returns only through its owned endpoint', async () => {
  assert.deepEqual(await handle('health.get', {}, signal), { ok: true, value: { database: { status: 'ready' } } });
  assert.equal((await handle('session/prompt', {}, signal)).error.code, 'not_found');
});
test('rejects input and cancellation without exposing internal errors', async () => {
  for (const input of ['sql', [], { path: '/tmp/other.sqlite' }, { token: 'secret' }]) {
    assert.equal((await handle('health.get', input, signal)).error.code, 'invalid_input');
  }
  assert.equal((await handle('health.get', {}, AbortSignal.abort())).error.code, 'cancelled');
  const failing = createHandler({ health: async () => { throw new Error('token=do-not-expose'); } });
  const result = await failing('health.get', {}, signal);
  assert.equal(result.error.code, 'unavailable');
  assert.ok(!JSON.stringify(result).includes('do-not-expose'));
});

test('exact Fetch adapter preserves native RPC envelope and bounds request bodies', async () => {
  const { createFetchHandler } = await import('../lib/query.js');
  const fetch = createFetchHandler('health.get', handle, {});
  const request = (body, type = 'application/json') => new Request('http://localhost/api/dsh-observe/health.get', { method: 'POST', headers: { 'content-type': type }, body: JSON.stringify(body) });
  const envelope = { type: 'client-request', rpcId: 'test-1', method: 'dsh-observe/health.get', payload: {} };
  const result = await (await fetch(request(envelope))).json();
  assert.equal(result.type, 'server-response');
  assert.equal(result.rpcId, 'test-1');
  assert.equal(result.result.ok, true);
  assert.equal((await fetch(request({ ...envelope, method: 'session/prompt' }))).status, 400);
  assert.equal((await fetch(request(envelope, 'text/plain'))).status, 415);
  assert.equal((await fetch(request({ ...envelope, payload: 'x'.repeat(17000) }))).status, 413);
});

test('source endpoint projects metadata instead of exposing arbitrary tool meta or plugin payloads', async () => {
  const event = { seq: 0, time: 1000, type: 'plugin/custom', ignorable: true, data: { meta: { patch: 'private-patch' }, customPayload: 'private-plugin-data', content: 'private-prompt' } };
  const handle = createHandler({ health: async () => ({ database: { revision: 1 } }), sessionQuery: { async readEvent() {
    return { session: { id: 'session-a', version: 4, createdAt: 1000, cwd: '/private-path' }, target: event, events: [event], inheritedEventCount: 0, startSeq: 0, endSeq: 0 };
  } } });
  const result = await handle('events.get', { sessionId: 'session-a', seq: 0 }, signal);
  assert.equal(result.ok, true);
  assert.equal(result.value.target.type, 'plugin/custom');
  assert.equal(result.value.contentPolicy, 'metadata-only');
  assert.ok(!JSON.stringify(result).includes('private-'));
});

test('inspection rejects a node outside the selected Run before reading session content',async()=>{
 let read=false;
 const handler=createHandler({store:{async call(operation){return operation==='runs.get'?{id:'run-a',sessionId:'session-a'}:{items:[]};}},sessionQuery:{async observeSession(){read=true;}}});
 const result=await handler('requests.get',{runId:'run-a',nodeId:'node-other'},signal);
 assert.equal(result.error.code,'not_found');assert.equal(read,false);
});
test('content reads validate selectors and bounds instead of accepting arbitrary paths or large pages',async()=>{
 let reads=0;const handler=createHandler({sessionQuery:{async readEvent(){reads++;}}});
 for(const input of [{part:'../../secret'},{part:'event',limit:1000000},{part:'event',offset:-1},{part:'event',path:'/tmp/secret'}]) {
  const result=await handler('content.get',{sessionId:'session-a',seq:0,...input},signal);assert.equal(result.error.code,'invalid_input');
 }
 assert.equal(reads,0);
});

test('request category filters accept only known semantic types',async()=>{
 for(const category of ['user-approval','developer','../../secret',{},''])
  assert.equal((await handle('requests.get',{runId:'run-a',category},signal)).error.code,'invalid_input');
});
test('unassociated log scope is a validated boolean',async()=>{
 for(const unassociated of ['true',1,{},null])
  assert.equal((await handle('logs.list',{unassociated},signal)).error.code,'invalid_input');
});
