import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../lib/store.js';
import { summarize } from '../lib/fold.js';
import { fixtures } from './fixtures/rc2.mjs';
const info = { id: 'session-a', version: 4, inheritedEventCount: 0, agentId: 'agent-a' };
async function setup(t) {
  const directory = await mkdtemp(join(tmpdir(), 'observe-recovery-'));
  const store = new Store(directory); await store.ready;
  t.after(async () => { await store.close(); await rm(directory, { recursive: true, force: true }); });
  return { store, directory };
}
const ingest = (store, events, meta = info) => store.call('batch', { info: meta, events: events.map(summarize) });
test('restart marks unfinished work unknown; canonical suffix recovers without double usage', async (t) => {
  const { store, directory } = await setup(t);
  await ingest(store, fixtures.success.slice(0, 3));
  const before = (await store.call('runs.list', {})).items[0];
  await store.close();
  const restarted = new Store(directory); await restarted.ready;
  try {
    assert.equal((await restarted.call('runs.get', { runId: before.id })).status, 'unknown');
    await ingest(restarted, fixtures.success);
    const after = await restarted.call('runs.get', { runId: before.id });
    assert.equal(after.status, 'completed');
    assert.equal(after.attempts, 1);
    assert.equal(after.usage.totalTokens, 13);
    assert.equal((await restarted.call('session.get', { sessionId: info.id })).indexedThroughSeq, 6);
  } finally { await restarted.close(); }
});
test('transactional watermarks refuse gaps; reindex preserves logs and immutable bindings', async (t) => {
  const { store } = await setup(t);
  await assert.rejects(ingest(store, fixtures.success.slice(1)), /store_operation_failed/);
  assert.equal(await store.call('session.get', { sessionId: info.id }), null);
  await ingest(store, fixtures.success);
  const log = { time: Date.now(), level: 'warn', source: 'fixture', summary: 'Redacted diagnostic', sessionId: info.id, runId: null, nodeId: null };
  await store.call('logs.add', [log]);
  const binding = { sessionId: info.id, requestId: 'request-a', userId: 'user-a', sourcePlugin: 'fixture' };
  await store.call('context.bind', binding);
  await store.call('context.bind', binding);
  await assert.rejects(store.call('context.bind', { ...binding, userId: 'user-b' }), /binding_conflict/);
  await store.call('rebuild');
  assert.equal((await store.call('logs.list', {})).items.length, 1);
  await assert.rejects(store.call('context.bind', { ...binding, userId: 'user-b' }), /binding_conflict/);
  await ingest(store, fixtures.success);
  assert.equal((await store.call('runs.list', {})).items.length, 1);
});
test('keyset cursors bind filters and paginate without duplicates', async (t) => {
  const { store } = await setup(t);
  for (let i = 0; i < 5; i++) await ingest(store, fixtures.success, { ...info, id: `session-${i}` });
  const first = await store.call('runs.list', { limit: 2 });
  const second = await store.call('runs.list', { limit: 2, cursor: first.nextCursor });
  assert.equal(first.items.length, 2);
  assert.ok(!first.items.some((a) => second.items.some((b) => a.id === b.id)));
  await assert.rejects(store.call('runs.list', { status: 'error', limit: 2, cursor: first.nextCursor }), /invalid_cursor/);
});
test('schema upgrade backs up old database; corrupt database stays intact', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'observe-migration-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const db = new DatabaseSync(join(directory, 'observe.sqlite'));
  db.exec("CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL); INSERT INTO metadata VALUES ('namespace','old-source'); PRAGMA user_version=1;"); db.close();
  const store = new Store(directory); await store.ready;
  assert.equal((await store.health()).namespace, 'old-source');
  await store.close();
  assert.ok((await readdir(directory)).some((file) => file.endsWith('.bak')));
  const corruptDirectory = join(directory, 'corrupt');
  const { mkdir } = await import('node:fs/promises'); await mkdir(corruptDirectory);
  const path = join(corruptDirectory, 'observe.sqlite'); await writeFile(path, 'preserve-corrupt-file');
  const corrupt = new Store(corruptDirectory);
  await assert.rejects(corrupt.ready, /unavailable/); await corrupt.close();
  assert.equal(await readFile(path, 'utf8'), 'preserve-corrupt-file');
});

test('only explicit turn/call metadata associates logs; same-time lines stay unassigned', async (t) => {
  const { store } = await setup(t); await ingest(store, fixtures.success);
  const run = (await store.call('runs.list', {})).items[0];
  const log = { time: Date.now(), level: 'error', source: 'fixture', summary: 'Synthetic error', sessionId: info.id, runId: null, nodeId: null };
  await store.call('logs.add', [log, { ...log, nativeTurn: 1, nativeStep: 1, nativeCallId: 'call-1' }]);
  const correlated = await store.call('logs.list', { runId: run.id });
  assert.equal(correlated.items.length, 1);
  assert.ok(correlated.items[0].nodeId);
  assert.equal((await store.call('logs.list', { sessionId: info.id })).items.length, 2);
});
test('worker termination rejects outstanding operations; source database survives', async (t) => {
  const { store, directory } = await setup(t);
  await ingest(store, fixtures.success);
  await store.worker.terminate();
  await assert.rejects(store.health(), /stopped|closed|terminated/);
  assert.ok((await readFile(join(directory, 'observe.sqlite'))).length > 0);
});
test('read-only directory is refused without removing it', async (t) => {
  const { chmod } = await import('node:fs/promises');
  const directory = await mkdtemp(join(tmpdir(), 'observe-readonly-'));
  t.after(async () => { await chmod(directory, 0o700); await rm(directory, { recursive: true, force: true }); });
  await chmod(directory, 0o500);
  const store = new Store(directory);
  await assert.rejects(store.ready, /unavailable/);
  await store.close();
});

test('trusted request bindings remain scoped across concurrent Sessions and report late arrival', async (t) => {
  const { store } = await setup(t);
  const events = [{ seq: 0, time: 1000, type: 'turn/start', data: { turn: 1 } },
    { seq: 1, time: 1010, type: 'user/message', data: { id: 'message-a', source: { kind: 'rpc', rpcId: 'shared-request' } } },
    { seq: 2, time: 1020, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } }];
  await Promise.all(['a', 'b'].map(async (name) => {
    await store.call('context.bind', { sessionId: `session-${name}`, requestId: 'shared-request', userId: `user-${name}`, sourcePlugin: 'trusted-fixture' });
    await ingest(store, events, { ...info, id: `session-${name}` });
  }));
  const runs = (await store.call('runs.list', {})).items;
  for (const run of runs) {
    const result = await store.call('runs.get', { runId: run.id });
    assert.equal(result.contexts.length, 1);
    assert.equal(result.contexts[0].userId, run.sessionId.replace('session', 'user'));
    assert.equal(result.contexts[0].association, 'late');
  }
  assert.equal((await store.call('runs.list', { userId: 'user-a' })).items.length, 1);
  assert.equal((await store.call('runs.list', { unbound: true })).items.length, 0);
});

test('log search filters summaries across all pages and reports counts before text filters', async (t) => {
  const { store } = await setup(t); const now = Date.now();
  const base = { time: now, level: 'warn', source: 'fixture.logger', sessionId: null, runId: null, nodeId: null, summary: 'ordinary diagnostic' };
  await store.call('logs.add', [...Array.from({length:55},(_,i)=>({...base,time:now-i})),
    {...base,time:now-100,summary:'中文诊断 ScopeProbe 100%_literal'},
    {...base,sessionId:'session-scoped',summary:'another session'}]);
  const all = await store.call('logs.list', {limit:50});
  assert.equal(all.scopeCount,57);assert.equal(all.unassociatedCount,56);assert.equal(all.items.length,50);
  for(const text of ['scopeprobe','中文诊断','100%_literal']) {
    const found=await store.call('logs.list',{text,unassociated:true});
    assert.equal(found.items.length,1);assert.equal(found.scopeCount,56);
  }
  assert.equal((await store.call('logs.list',{source:'fixture.log'})).items.length,0);
  assert.equal((await store.call('logs.list',{source:'fixture.logger',text:'ScopeProbe'})).items.length,1);
  const empty=await store.call('logs.list',{sessionId:'no-logs',text:'ScopeProbe'});
  assert.equal(empty.scopeCount,0);assert.equal(empty.unassociatedCount,56);assert.equal(empty.items.length,0);
  const scoped=await store.call('logs.list',{sessionId:'session-scoped'});
  assert.equal(scoped.scopeCount,1);assert.equal(scoped.items.length,1);
  assert.equal((await store.call('logs.list',{level:'error',text:'ScopeProbe'})).items.length,0);
  assert.equal((await store.call('logs.list',{text:"' OR 1=1 --"})).items.length,0);
});
