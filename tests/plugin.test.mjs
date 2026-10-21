import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import * as plugin from '../lib/index.js';
import { VERSION, HOST_VERSION } from '../lib/types.js';
import { fixtures } from './fixtures/rc2.mjs';

test('package, runtime, lockfile and DSH dependencies share the release baseline', async () => {
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const lock = JSON.parse(await readFile(new URL('../package-lock.json', import.meta.url), 'utf8'));
  assert.equal(VERSION, manifest.version);
  assert.equal(lock.version, VERSION);
  assert.equal(lock.packages[''].version, VERSION);
  for (const group of ['dependencies', 'devDependencies', 'peerDependencies']) {
    assert.deepEqual(lock.packages[''][group], manifest[group]);
    for (const [name, version] of Object.entries(manifest[group])) {
      if (name.startsWith('@deepseek-ai/dsh')) assert.equal(version, HOST_VERSION, name);
    }
  }
});

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
  const registered = new Map();
  ctx.provide('connection', { browserPeer: { id: 'browser-owner' }, fetch: { register(route) {
    assert.ok(route.path.startsWith('/api/dsh-observe/'));
    registered.set(route.path, route.fetch);
    routes++;
    return async () => { registered.delete(route.path); routes--; };
  } } });
  ctx.provide('webServer', {});
  ctx.provide('sessions', { list: () => [] });
  ctx.provide('sessionQuery', {
    async observeSession() { return { header: { version: 4 }, inheritedEventCount: 0, events: fixtures.success, [Symbol.dispose]() {} }; },
    async listSessions() { return []; },
  });
  let namespace;
  for (let i = 0; i < 10; i++) {
    const fiber = await ctx.plugin(plugin);
    const health = await fiber.ctx.dshObserve.health();
    namespace ??= health.database.namespace;
    assert.equal(health.database.namespace, namespace);
    assert.equal(health.pluginVersion, VERSION);
    assert.equal(health.hostVersion, HOST_VERSION);
    assert.equal(routes, 8);
    if (i === 0) {
      const rpc = async (endpoint, payload) => {
        const response = await registered.get(`/api/dsh-observe/${endpoint}`)(new Request(`http://localhost/api/dsh-observe/${endpoint}`, {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'client-request', rpcId: 'peer-test', method: `dsh-observe/${endpoint}`, payload }),
        }));
        const { result } = await response.json(); assert.equal(result.ok, true); return result.value;
      };
      const runs = await rpc('runs.list', { sessionId: 'session-a' });
      assert.equal((await rpc('runs.get', { runId: runs.items[0].id })).operatorId, 'browser-owner');
    }
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
  ctx.provide('connection', { browserPeer: {}, fetch: { register() { return async () => {}; } } });
  ctx.provide('sessions', { list: () => [] }); ctx.provide('sessionQuery', {});
  const fiber = await ctx.plugin(plugin);
  for (let i = 0; i < 20; i++) ctx.logger('fixture').warn('accepted before unload', i);
  await fiber.dispose();
  const db = new DatabaseSync(join(home, 'storages/dsh-observe/observe.sqlite'), { readOnly: true });
  try { assert.equal(db.prepare('SELECT count(*) AS count FROM logs').get().count, 20); } finally { db.close(); }
});
