import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarize, fold, initialState } from '../lib/fold.js';
import { fixtures } from './fixtures/rc2.mjs';
const info = { id: 'session-a', version: 4, inheritedEventCount: 0, agentId: null };
function replay(events, meta = info) {
  const state = initialState(); const nodes = new Map(); let run;
  for (const event of events) {
    const result = fold(state, meta, summarize(event), 'source');
    for (const node of result.nodes) nodes.set(node.id, node);
    run = result.runs.at(-1) ?? run;
  }
  return { state, run, nodes: [...nodes.values()] };
}
test('canonical events produce one attempt, paired tool, authoritative usage and stop reason', () => {
  const { run, nodes } = replay(fixtures.success);
  assert.equal(run.status, 'completed');
  assert.equal(run.taskOutcome, 'not_evaluated');
  assert.equal(run.attempts, 1);
  assert.deepEqual(run.usage, { inputTokens: 10, outputTokens: 3, totalTokens: 13 });
  const tool = nodes.find((node) => node.kind === 'tool');
  assert.equal(tool.status, 'completed');
  assert.equal(tool.endSeq, 4);
  assert.equal(tool.parentId, nodes.find((node) => node.kind === 'step').id);
});
test('retry counts failed attempt, keeps missing usage unknown, and closes actual wait', () => {
  const { run, nodes } = replay(fixtures.retry);
  assert.equal(run.attempts, 2);
  assert.equal(run.retries, 1);
  assert.equal(run.usageComplete, false);
  assert.equal(nodes.find((node) => node.kind === 'retry').endTime, 1050);
});
test('cancellation does not fabricate missing tool result', () => {
  const { run, nodes } = replay(fixtures.cancel.filter((event) => event.type !== 'tool/result').map((event, seq) => ({ ...event, seq })));
  assert.equal(run.status, 'cancelled');
  const tool = nodes.find((node) => node.kind === 'tool');
  assert.equal(tool.status, 'unknown');
  assert.equal(tool.endTime, undefined);
});
test('PTC sub-dispatch is nested under its evidenced parent', () => {
  const tools = replay(fixtures.nested).nodes.filter((node) => node.kind === 'tool');
  assert.equal(tools.length, 2);
  assert.equal(tools[1].parentId, tools[0].id);
  assert.equal(tools[1].status, 'completed');
});
test('catalog lineage never fabricates a tool parent; manual compaction stays outside Run', () => {
  assert.equal(replay(fixtures.subagent).nodes.find((node) => node.kind === 'subagent').parentId, null);
  const compact = replay(fixtures.compaction);
  assert.equal(compact.run, undefined);
  assert.equal(compact.nodes[0].runId, null);
  assert.equal(compact.nodes[0].status, 'error');
});
test('fork excludes inherited model usage; interrupted recovery stays unknown', () => {
  const child = replay(fixtures.fork, { ...info, inheritedEventCount: 5 });
  assert.equal(child.run.turn, 2);
  assert.equal(child.run.usage, null);
  assert.equal(child.nodes.filter((node) => node.kind === 'attempt').length, 0);
  assert.equal(replay(fixtures.recovery).run.status, 'unknown');
});
test('same events deduplicate; gaps and unknown required formats refuse reconstruction', () => {
  const state = initialState(); const first = summarize(fixtures.success[0]);
  fold(state, info, first, 'source');
  assert.deepEqual(fold(state, info, first, 'source'), { runs: [], nodes: [] });
  assert.throws(() => fold(state, info, summarize(fixtures.success[2]), 'source'), /contiguous/);
  assert.throws(() => fold(initialState(), { ...info, version: 99 }, first, 'source'), /format/);
  assert.throws(() => fold(initialState(), info, { ...first, known: false }, 'source'), /vocabulary/);
});
test('parallel Sessions keep IDs separate and metadata never copies tool bodies', () => {
  const a = replay(fixtures.nested); const b = replay(fixtures.nested, { ...info, id: 'session-b' });
  assert.notEqual(a.run.id, b.run.id);
  assert.ok(!JSON.stringify(fixtures.success.map(summarize)).includes('Example answer'));
});

test('malformed usage remains unreported; long Unicode source IDs yield bounded stable local IDs', () => {
  const events = structuredClone(fixtures.success);
  events[2].data.usage = { inputTokens: 'not-a-number', outputTokens: -1 };
  const { run } = replay(events, { ...info, id: '会话'.repeat(500) });
  assert.equal(run.usage, null);
  assert.equal(run.usageComplete, false);
  assert.ok(run.id.length < 150);
});
test('native recovery tool outcome remains unknown rather than a fabricated successful tool', () => {
  const events = structuredClone(fixtures.success);
  const result = events.find((event) => event.type === 'tool/result');
  result.data.message.isError = true;
  result.data.error = { name: 'ToolOutcomeUnknownError', code: 'TOOL_OUTCOME_UNKNOWN' };
  assert.equal(replay(events).nodes.find((node) => node.kind === 'tool').status, 'unknown');
});

test('summary and model-free prune retain surface-position bounds without counting summary usage as a normal attempt', () => {
  const rows = [
    ['compaction/start', { compactionId: 'c', turn: null }],
    ['compaction/summary', { compactionId: 'c', model: 'summary-model', usage: { inputTokens: 20, outputTokens: 5 }, shadowedRange: { start: 10, end: 2 }, shadowedSeqs: [10, 2], summary: [{ text: 'private-summary' }] }],
    ['compaction/end', { compactionId: 'c', turn: null }],
    ['compaction/prune', { shadowedRange: { start: 3, end: 4 }, shadowedSeqs: [3, 4] }],
  ].map(([type, data], seq) => ({ type, data, seq, time: 1000 + seq }));
  const { nodes, run } = replay(rows);
  assert.equal(run, undefined);
  assert.equal(nodes[0].status, 'completed');
  assert.equal(nodes[0].summarySeq, 1);
  assert.deepEqual(nodes[0].replacement, { start: 10, end: 2, count: 2 });
  assert.deepEqual(nodes[0].usage, { inputTokens: 20, outputTokens: 5 });
  assert.equal(nodes[1].kind, 'prune');
  assert.equal(nodes[1].usage, undefined);
  assert.ok(!JSON.stringify(nodes).includes('private-summary'));
});
test('truncated, blocked and unknown reasons never become task success; inbox waits use consumption evidence', () => {
  for (const [reason, status] of [['max-tokens', 'truncated'], ['blocked', 'blocked'], ['other', 'unknown']]) {
    const rows = structuredClone(fixtures.success); rows.at(-1).data.reason = { kind: reason };
    assert.equal(replay(rows).run.status, status);
  }
  const rows = [
    ['agent/inbox/spliced', { inserted: [{ id: 'm', source: { rpcId: 'r' } }] }],
    ['turn/start', { turn: 1 }], ['user/message', { id: 'm' }],
    ['turn/end', { turn: 1, reason: { kind: 'completed' } }],
  ].map(([type, data], seq) => ({ type, data, seq, time: 1000 + seq * 10 }));
  const { run } = replay(rows);
  assert.deepEqual(run.requestIds, ['r']); assert.deepEqual(run.messageIds, ['m']); assert.deepEqual(run.queueWaits, { m: 20 });
});

test('unknown ignorable events remain visible with partial coverage', () => {
  const rows = structuredClone(fixtures.success);
  rows.splice(2, 0, { seq: 2, time: 1015, type: 'plugin/custom', data: { privateBody: 'omitted' }, ignorable: true });
  const { run, nodes } = replay(rows.map((event, seq) => ({ ...event, seq })));
  assert.equal(run.coverage, 'partial');
  assert.equal(nodes.find((node) => node.kind === 'event').status, 'unknown');
  assert.ok(!JSON.stringify(nodes).includes('omitted'));
});

test('surface replacements never create another tool execution or attach a checkpoint to a finished Run', () => {
  const summary = replay(fixtures.summary);
  assert.equal(summary.run.tools, 1); assert.deepEqual(summary.run.messageIds, []);
  assert.equal(summary.nodes.find((node) => node.kind === 'compaction').usage.outputTokens, 5);
  const prune = replay(fixtures.prune);
  assert.equal(prune.run.tools, 1); assert.equal(prune.run.coverage, 'complete');
  assert.equal(prune.nodes.filter((node) => node.kind === 'tool').length, 1);
  assert.equal(prune.nodes.find((node) => node.kind === 'prune').runId, prune.run.id);
  assert.equal(prune.run.usage.totalTokens, 13);
});

test('native Agent identity learned after Turn start attaches without inventing one for history', () => {
  const state = initialState(); let run;
  for (const event of fixtures.success) {
    run = fold(state, { ...info, agentId: event.seq < 3 ? null : 'native-agent-a' }, summarize(event), 'source').runs.at(-1);
  }
  assert.equal(run.agentId, 'native-agent-a');
  assert.equal(replay(fixtures.success).run.agentId, null);
});
