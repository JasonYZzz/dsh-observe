import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import * as plugin from '../lib/index.js';

test('ten Cordis mount/unmount cycles release RPC and SQLite resources', async (t) => {
  const previous = process.env.DSH_HOME;
  const home = await mkdtemp(join(tmpdir(), 'observe-plugin-'));
  process.env.DSH_HOME = home;
  t.after(async () => {
    if (previous === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previous;
    await rm(home, { recursive: true, force: true });
  });
  const ctx = new Context();
  let routes = 0;
  ctx.provide('connection', { operator: {}, fetch: { register(route) {
    assert.ok(route.path.startsWith('/api/dsh-observe/'));
    routes++;
    return async () => { routes--; };
  } } });
  ctx.provide('webServer', {});
  ctx.provide('sessions', { list: () => [] });
  ctx.provide('sessionQuery', {});
  let namespace;
  for (let i = 0; i < 10; i++) {
    const fiber = await ctx.plugin(plugin);
    const health = await fiber.ctx.dshObserve.health();
    namespace ??= health.database.namespace;
    assert.equal(health.database.namespace, namespace);
    assert.equal(routes, 8);
    await fiber.dispose();
    assert.equal(routes, 0);
  }
});

test('Cordis parallel disposers still drain accepted logs before database worker closes', async (t) => {
  const { DatabaseSync } = await import('node:sqlite');
  const previous = process.env.DSH_HOME;
  const home = await mkdtemp(join(tmpdir(), 'observe-drain-'));
  process.env.DSH_HOME = home;
  t.after(async () => { if (previous === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previous; await rm(home, { recursive: true, force: true }); });
  const ctx = new Context();
  ctx.provide('connection', { operator: {}, fetch: { register() { return async () => {}; } } });
  ctx.provide('sessions', { list: () => [] }); ctx.provide('sessionQuery', {});
  const fiber = await ctx.plugin(plugin);
  for (let i = 0; i < 20; i++) ctx.logger('fixture').warn('accepted before unload', i);
  await fiber.dispose();
  const db = new DatabaseSync(join(home, 'storages/dsh-observe/observe.sqlite'), { readOnly: true });
  try { assert.equal(db.prepare('SELECT count(*) AS count FROM logs').get().count, 20); } finally { db.close(); }
});
