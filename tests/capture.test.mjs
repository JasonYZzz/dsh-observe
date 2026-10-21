import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import { Store } from '../lib/store.js';
import { Capture } from '../lib/capture.js';
import { fixtures } from './fixtures/rc2.mjs';
test('cold indexing uses disposable read lease and never resumes Agent; live overlap deduplicates', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'observe-capture-'));
  const store = new Store(directory); await store.ready;
  let released = 0; let observed = 0; let capture;
  const ctx = new Context();
  const session = { id: 'fixture-session', header: { id: 'fixture-session', version: 4 }, inheritedEventCount: 0 };
  ctx.provide('sessions', { list: () => [] });
  ctx.provide('sessionQuery', { async observeSession() {
    observed++;
    return { header: session.header, inheritedEventCount: 0, events: fixtures.success, [Symbol.dispose]() { released++; } };
  } });
  const plugin = { inject: ['sessions', 'sessionQuery'], apply(ctx) { capture = new Capture(ctx, store); ctx.effect(() => () => capture.dispose()); } };
  const fiber = await ctx.plugin(plugin);
  t.after(async () => { await fiber.dispose(); await store.close(); await rm(directory, { recursive: true, force: true }); });
  ctx.emit('agent/error', { agent: { id: 'native-agent-a', session }, error: new Error('Synthetic error'), turn: 1, step: 1 });
  await capture.ensure('fixture-session');
  assert.equal(released, observed);
  const before = (await store.call('runs.list', {})).items[0];
  assert.equal(before.agentId, 'native-agent-a');
  ctx.emit('session/event', session, fixtures.success.at(-1));
  await capture.settle();
  const after = (await store.call('runs.list', {})).items[0];
  assert.equal(before.id, after.id);
  assert.equal(after.attempts, 1);
  assert.equal(released, observed);
});

test('logger burst has a fixed queue limit, reports loss and releases exporter on unload', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'observe-backpressure-'));
  const store = new Store(directory); await store.ready;
  const ctx = new Context(); let capture;
  const exporterBaseline = ctx.logger.exporters.size;
  ctx.provide('sessions', { list: () => [] }); ctx.provide('sessionQuery', {});
  const fiber = await ctx.plugin({ inject: ['sessions', 'sessionQuery'], apply(ctx) { capture = new Capture(ctx, store); ctx.effect(() => () => capture.dispose()); } });
  t.after(async () => { await fiber.dispose(); await store.close(); await rm(directory, { recursive: true, force: true }); });
  for (let i = 0; i < 3000; i++) ctx.logger('fixture').warn('Synthetic record %s', i);
  assert.equal(capture.health().queued, 2048);
  assert.equal(capture.health().droppedLogs, 952);
  await capture.settle();
  assert.equal(capture.health().queued, 0);
  await fiber.dispose();
  assert.equal(ctx.logger.exporters.size, exporterBaseline);
});

test('live Frames are bounded metadata overlays and disappear at canonical commit', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'observe-frames-'));
  const store = new Store(directory); await store.ready;
  const ctx = new Context(); let capture;
  ctx.provide('sessions', { list: () => [] }); ctx.provide('sessionQuery', {});
  const fiber = await ctx.plugin({ inject: ['sessions', 'sessionQuery'], apply(ctx) { capture = new Capture(ctx, store); ctx.effect(() => () => capture.dispose()); } });
  t.after(async () => { await fiber.dispose(); await store.close(); await rm(directory, { recursive: true, force: true }); });
  const agent = { id: 'agent-a', session: { id: 'session-a' } };
  const emit = (frame) => ctx.emit('agent/assistant-stream', { agent, frame: { turn: 1, step: 1, attemptId: 'attempt-1', ...frame } });
  emit({ type: 'start', revision: 0 });
  emit({ type: 'chunk', revision: 1, index: 0, time: 100, chunk: { type: 'text-delta', text: 'secret-body' } });
  emit({ type: 'chunk', revision: 2, index: 2, time: 110, chunk: { type: 'text-delta', text: 'secret-body' } });
  const [frame] = capture.progress('session-a', 1);
  assert.equal(frame.firstToken, 100); assert.equal(frame.lastToken, 110); assert.equal(frame.complete, false);
  assert.ok(!JSON.stringify(frame).includes('secret-body'));
  emit({ type: 'end', revision: 3, committedSeq: 2 });
  assert.equal(capture.progress('session-a', 1).length, 0);
  assert.equal((await store.call('runs.list', {})).items.length, 0);
  for (let i = 0; i < 140; i++) emit({ type: 'start', revision: 0, attemptId: `attempt-${i}` });
  assert.equal(capture.progress('session-a', 1).length, 128);
  assert.equal(capture.health().gaps, 12);
});

test('oversized history releases its lease and records a recoverable indexing failure', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'observe-limit-'));
  const store = new Store(directory); await store.ready;
  const ctx = new Context(); let capture; let released = 0; let oversized = true;
  ctx.provide('sessions', { list: () => [] });
  ctx.provide('sessionQuery', { async observeSession() { return { header: { id: 'session-a', version: 4 }, inheritedEventCount: 0,
    events: oversized ? new Array(100_001) : fixtures.success, [Symbol.dispose]() { released++; } }; } });
  const fiber = await ctx.plugin({ inject: ['sessions', 'sessionQuery'], apply(ctx) { capture = new Capture(ctx, store); ctx.effect(() => () => capture.dispose()); } });
  t.after(async () => { await fiber.dispose(); await store.close(); await rm(directory, { recursive: true, force: true }); });
  await assert.rejects(capture.ensure('session-a'), /100000/);
  assert.equal(released, 1); assert.equal(capture.health().failedSessions, 1);
  assert.ok((await store.call('session.get', { sessionId: 'session-a' })).error);
  oversized = false; await capture.ensure('session-a');
  assert.equal(released, 2); assert.equal(capture.health().failedSessions, 0);
});

test('cancelling an in-flight native read clears the pending slot without poisoning later queries', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'observe-abort-'));
  const store = new Store(directory); await store.ready;
  const ctx = new Context(); let capture; let began;
  const started = new Promise((resolve) => { began = resolve; });
  ctx.provide('sessions', { list: () => [] });
  ctx.provide('sessionQuery', { observeSession(id, { signal }) { began(); return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })); } });
  const fiber = await ctx.plugin({ inject: ['sessions', 'sessionQuery'], apply(ctx) { capture = new Capture(ctx, store); ctx.effect(() => () => capture.dispose()); } });
  t.after(async () => { await fiber.dispose(); await store.close(); await rm(directory, { recursive: true, force: true }); });
  const control = new AbortController(); const pending = capture.ensure('session-a', control.signal);
  await started; control.abort(); await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(capture.health().queued, 0); assert.equal(capture.health().failedSessions, 0);
  assert.equal((await store.health()).status, 'ready');
});

for (const failure of ['queue overflow', 'transient read failure', 'unchanged history']) {
  test(`cold indexing recovers after ${failure}`, async (t) => {
    const directory = await mkdtemp(join(tmpdir(), 'observe-retry-'));
    const store = new Store(directory); await store.ready;
    const ctx = new Context(); let capture; let reads = 0; let failRead = false;
    const session = { id: 'session-a', header: { id: 'session-a', version: 4 }, inheritedEventCount: 0 };
    ctx.provide('sessions', { list: () => [] });
    ctx.provide('sessionQuery', { async observeSession() {
      reads++;
      if (failRead) throw new Error('Temporary read failure');
      return { header: session.header, inheritedEventCount: 0, events: fixtures.success, [Symbol.dispose]() {} };
    } });
    const fiber = await ctx.plugin({ inject: ['sessions', 'sessionQuery'], apply(ctx) { capture = new Capture(ctx, store); ctx.effect(() => () => capture.dispose()); } });
    t.after(async () => { await fiber.dispose(); await store.close(); await rm(directory, { recursive: true, force: true }); });
    if (failure === 'queue overflow') {
      for (let i = 0; i < 2048; i++) ctx.logger('fixture').info('Queue filler');
      ctx.emit('session/created', session);
      await capture.settle();
      assert.equal(reads, 0);
    } else {
      if (failure === 'unchanged history') await capture.ensure(session.id);
      failRead = true;
      ctx.emit('session/created', session);
      await capture.settle();
      assert.equal(capture.health().failedSessions, 1);
      failRead = false;
    }
    const readsBeforeRetry = reads;
    if (failure === 'unchanged history') await capture.ensure(session.id);
    else { ctx.emit('session/event', session, fixtures.success[0]); await capture.settle(); }
    assert.equal(reads, readsBeforeRetry + 1);
    assert.equal((await store.call('runs.list', {})).items[0].status, 'completed');
    assert.equal(capture.health().failedSessions, 0);
    assert.equal((await store.call('capture.health')).failedSessions, 0);
    assert.equal((await store.call('session.get', { sessionId: session.id })).error, null);
  });
}

test('logger captures error/warn/info and preserves explicit session metadata; payload text never infers scope', async(t)=>{
 const directory=await mkdtemp(join(tmpdir(),'observe-log-scope-'));const store=new Store(directory);await store.ready;
 const ctx=new Context();let capture;ctx.provide('sessions',{list:()=>[]});ctx.provide('sessionQuery',{});
 const fiber=await ctx.plugin({inject:['sessions','sessionQuery'],apply(ctx){capture=new Capture(ctx,store);ctx.effect(()=>()=>capture.dispose());}});
 t.after(async()=>{await fiber.dispose();await store.close();await rm(directory,{recursive:true,force:true});});
 const scoped=ctx.logger('fixture-scoped');scoped.meta={sessionId:'explicit-session'};
 scoped.error('error diagnostic');scoped.warn('warning diagnostic');scoped.info('info diagnostic');scoped.debug('debug omitted');
 ctx.logger('fixture-unscoped').warn({sessionId:'explicit-session',text:'payload is not association metadata'});
 await capture.settle();
 const result=await store.call('logs.list',{sessionId:'explicit-session'});
 assert.equal(result.scopeCount,3);assert.deepEqual(result.items.map(item=>item.level).sort(),['error','info','warn']);
 const unassociated=await store.call('logs.list',{unassociated:true});assert.equal(unassociated.scopeCount,1);
 assert.match(unassociated.items[0].summary,/payload is not association metadata/);
});
