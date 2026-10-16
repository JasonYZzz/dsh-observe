import { performance } from 'node:perf_hooks';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir, cpus, platform, arch } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { Store } from '../lib/store.js';
import { summarize } from '../lib/fold.js';
import { fixtures } from '../tests/fixtures/rc2.mjs';
const directory = await mkdtemp(join(tmpdir(), 'observe-benchmark-'));
const store = new Store(directory);
const samples = async (run) => { const values = []; for (let i = 0; i < 30; i++) { const start = performance.now(); await run(); values.push(performance.now() - start); } values.sort((a,b) => a-b); return Number(values[Math.floor(values.length * .95)].toFixed(3)); };
try {
  await store.ready;
  const rssBefore = process.memoryUsage().rss;
  const base = Date.now() - 100_000;
  const info = { id: 'benchmark-session', version: 4, inheritedEventCount: 0, agentId: null };
  const events = [summarize(fixtures.success[0])];
  for (let step = 1; step <= 3334; step++) for (const original of fixtures.success.slice(1, -1)) {
    const event = summarize(original); event.seq = events.length; event.time = base + event.seq; event.step = step;
    if (event.streamStart !== undefined) event.streamStart = event.time;
    if (event.streamEnd !== undefined) event.streamEnd = event.time + 1;
    events.push(event);
  }
  events.push({ ...summarize(fixtures.success.at(-1)), seq: events.length, time: base + events.length });
  const ingestStart = performance.now();
  for (let offset = 0; offset < events.length; offset += 128) await store.call('batch', { info, events: events.slice(offset, offset + 128) });
  const ingestMs = performance.now() - ingestStart;
  const logStart = performance.now();
  for (let offset = 0; offset < 100_000; offset += 1000) await store.call('logs.add', Array.from({ length: 1000 }, (_, i) => ({
    time: base + offset + i, level: 'info', source: 'benchmark', summary: `Synthetic diagnostic ${offset + i}`, sessionId: info.id, runId: null, nodeId: null,
  })));
  const logsMs = performance.now() - logStart;
  const run = (await store.call('runs.list', { limit: 50 })).items[0];
  let cursor; let nodeCount = 0;
  do { const page = await store.call('runs.nodes', { runId: run.id, limit: 200, cursor }); nodeCount += page.items.length; cursor = page.nextCursor; } while (cursor);
  assert.equal(nodeCount, 10_002);
  const listenerSamples = [];
  for (let i = 0; i < 10_000; i++) { const start = performance.now(); summarize(fixtures.success[i % fixtures.success.length]); listenerSamples.push(performance.now() - start); }
  listenerSamples.sort((a,b) => a-b);
  const report = { measuredAt: new Date().toISOString(), node: process.versions.node, machine: { platform: platform(), arch: arch(), cpu: cpus()[0]?.model },
    dataset: { nodes: nodeCount, logs: 100_000, events: events.length, source: 'synthetic metadata, not a real model or native cold decode' },
    ingestMs: Number(ingestMs.toFixed(1)), logsMs: Number(logsMs.toFixed(1)),
    summaryP95Ms: Number(listenerSamples[9500].toFixed(4)),
    nodesPageP95Ms: await samples(() => store.call('runs.nodes', { runId: run.id, limit: 50 })),
    logsPageP95Ms: await samples(() => store.call('logs.list', { limit: 50 })),
    fullTextMissP95Ms: await samples(() => store.call('logs.list', { text: 'unmatched-search-term', limit: 50 })),
    rssBefore, rssAfter: process.memoryUsage().rss, database: await store.health(),
  };
  assert.ok(report.summaryP95Ms < 1);
  assert.ok(report.nodesPageP95Ms < 300 && report.logsPageP95Ms < 300 && report.fullTextMissP95Ms < 300);
  await mkdir('docs/verification', { recursive: true });
  await writeFile('docs/verification/benchmark.json', JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
} finally { await store.close(); await rm(directory, { recursive: true, force: true }); }
