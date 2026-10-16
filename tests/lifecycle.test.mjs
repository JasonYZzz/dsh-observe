import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../lib/store.js';

test('SQLite worker retains namespace, releases writer lock and supports repeated close', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-observe-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new Store(directory);
  await store.ready;
  const first = await store.health();
  assert.equal(first.schemaVersion, 2);
  const contender = new Store(directory);
  await assert.rejects(contender.ready, /unavailable|locked/);
  await contender.close();
  assert.equal((await store.health()).namespace, first.namespace);
  await store.close();
  await store.close();
  const restored = new Store(directory);
  await restored.ready;
  assert.equal((await restored.health()).namespace, first.namespace);
  await restored.close();
  assert.ok((await readFile(join(directory, 'observe.sqlite'))).length > 0);
});
