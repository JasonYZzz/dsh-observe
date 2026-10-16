// Test-only Host plugin. Creates sanitized native Sessions, never an Agent or model request.
import { Session, SessionId } from '@deepseek-ai/dsh-session';
import { fixtures, largeFixture } from '../rc2.mjs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
export const inject = ['sessions', 'sessionPersistence', 'sessionQuery', 'dshObserve'];
export async function apply(ctx) {
  const base = Date.now() - 60_000;
  for (const [name, original] of Object.entries({ ...fixtures, ...(process.env.DSH_OBSERVE_LARGE_TEST ? { large: largeFixture() } : {}) })) {
    const id = SessionId(`observe-fixture-v2-${name}`);
    if (await ctx.sessionPersistence.stat(id)) {
      { const observation = await ctx.sessionQuery.observeSession(id, { projectionMode: 'none' }); observation[Symbol.dispose](); }
      continue;
    }
    const events = structuredClone(original);
    for (const event of events) {
      event.time += base;
      for (const item of event.data.stream ?? []) {
        if (item.time !== undefined) item.time += base;
        if (item.time0 !== undefined) item.time0 += base;
      }
    }
    const inheritedEventCount = name === 'fork' ? 5 : 0;
    const session = Session.create(id, events, { id, version: 4, createdAt: base, cwd: process.cwd(), isSeeded: inheritedEventCount > 0,
      ...(inheritedEventCount ? { parentSession: SessionId('observe-fixture-v2-success') } : {}) }, inheritedEventCount);
    session.append('session/title', { title: `Observe fixture ${name}`, messageSeqs: [], source: { kind: 'user' } });
    const handle = await ctx.sessionPersistence.create(session.header, { inheritedEventCount });
    try { await handle.append(session.snapshotEvents()); await handle.flush(); } finally { await handle.close(); }
  }
  if (process.env.DSH_OBSERVE_LARGE_TEST) {
    const rssBefore = process.memoryUsage().rss; const started = performance.now();
    const observation = await ctx.sessionQuery.observeSession(SessionId('observe-fixture-v2-large'), { projectionMode: 'none' });
    try { await writeFile(join(process.env.DSH_HOME, 'native-preparation.json'), JSON.stringify({ events: observation.events.length, prepareMs: performance.now() - started, rssBefore, rssAfter: process.memoryUsage().rss, format: 'native JSONL/Zstandard, synthetic tool bodies; single preparation, RSS is not peak memory' })); }
    finally { observation[Symbol.dispose](); }
  }
  await writeFile(join(process.env.DSH_HOME, 'fixture-ready'), 'ready');
  const scoped = ctx.logger('observe-scoped-fixture');
  scoped.meta = { sessionId: 'observe-fixture-v2-request' };
  scoped.warn('会话诊断 搜索命中 ScopeProbe 100%_literal');
  scoped.debug('Debug fixture should not be captured');
  ctx.logger('observe-fixture').warn('sanitized test diagnostic', { password: 'fixture-secret-never-expose', message: 'Synthetic warning, not a model call' });
}
