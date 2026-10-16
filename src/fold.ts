import { createHash } from 'node:crypto';
import { KNOWN_SESSION_EVENT_TYPES } from '@deepseek-ai/dsh-session';
import { safeText } from './policy.js';
import type { EventSummary, FoldState, Node, Run, SessionInfo, Status, Usage } from './types.js';

type RawEvent = { seq: number; time: number; type: string; data: unknown; ignorable?: boolean; surfaceOp?: unknown };
function record(value: unknown): Record<string, unknown> { return value && typeof value === 'object' ? value as Record<string, unknown> : {}; }
function text(value: unknown): string | undefined { return typeof value === 'string' ? value : undefined; }
function numeric(value: unknown): number | undefined { return typeof value === 'number' && Number.isFinite(value) ? value : undefined; }

function usage(value: unknown): Usage | undefined {
  const data = record(value);
  const valid = (count: unknown): count is number => typeof count === 'number' && Number.isSafeInteger(count) && count >= 0;
  if (!valid(data.inputTokens) || !valid(data.outputTokens)) return;
  const result: Usage = { inputTokens: data.inputTokens, outputTokens: data.outputTokens };
  for (const key of ['totalTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens'] as const) {
    if (data[key] !== undefined) { if (!valid(data[key])) return; result[key] = data[key]; }
  }
  return result;
}
export function summarize(event: RawEvent): EventSummary {
  const data = record(event.data);
  const message = record(data.message);
  const source = record(message.source ?? data.source);
  const reason = record(data.reason);
  const result: EventSummary = { seq: event.seq, time: event.time, type: event.type, known: KNOWN_SESSION_EVENT_TYPES.has(event.type), ignorable: event.ignorable, replacementEvent: event.surfaceOp !== null && typeof event.surfaceOp === 'object',
    turn: data.turn === null ? null : numeric(data.turn), step: numeric(data.step),
    callId: text(data.subCallId ?? data.callId ?? message.toolCallId), parentCallId: text(data.parentCallId),
    compactionId: text(data.compactionId), retryId: text(data.retryId), name: text(data.name),
    isError: data.isError === true || message.isError === true, reason: text(reason.kind ?? record(data.error).code),
    error: data.error ? safeText(JSON.stringify(data.error)) : undefined, model: text(source.model ?? data.model), childId: text(data.childId),
    requestId: text(source.rpcId), messageId: text(message.id ?? (event.type === 'user/message' ? data.id : undefined)),
  };
  if (Array.isArray(data.inserted) && data.inserted.length > 200) throw new Error('Inbox batch exceeds supported bound');
  if (event.type === 'request/header') {
    const config = record(record(data.header).config); result.configuration = {};
    for (const key of ['provider', 'model', 'reasoningEffort', 'maxTokens', 'temperature', 'topP', 'topK', 'frequencyPenalty', 'presencePenalty', 'seed']) {
      const value = config[key]; if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') result.configuration[key] = typeof value === 'string' ? safeText(value) : value;
    }
  }
  if (Array.isArray(data.inserted)) result.inserted = data.inserted.slice(0, 200).map((entry) => {
    const message = record(entry); return { messageId: String(message.id), requestId: text(record(message.source).rpcId) };
  });
  if (Array.isArray(data.stream)) {
    for (const entry of data.stream) {
      const item = record(entry);
      const start = numeric(item.time ?? item.time0);
      const dt = Array.isArray(item.dt) ? item.dt as number[] : [];
      const end = start === undefined ? undefined : start + dt.reduce((sum, value) => sum + value, 0);
      if (start !== undefined) result.streamStart = Math.min(result.streamStart ?? start, start);
      if (end !== undefined) result.streamEnd = Math.max(result.streamEnd ?? end, end);
      const chunk = record(item.chunk);
      if (chunk.type === 'finish') result.finishReason = text(record(chunk.reason).kind);
      if (chunk.type === 'usage') result.usage = usage(chunk.usage);
    }
  }
  if (data.usage) result.usage = usage(data.usage);
  if ((event.type === 'compaction/summary' || event.type === 'compaction/prune') &&
    Number.isSafeInteger(record(data.shadowedRange).start) && Number.isSafeInteger(record(data.shadowedRange).end) && Array.isArray(data.shadowedSeqs)) {
    result.replacement = { start: Number(record(data.shadowedRange).start), end: Number(record(data.shadowedRange).end), count: data.shadowedSeqs.length };
  }
  return result;
}
export function initialState(): FoldState { return { watermark: -1, run: null, step: null, open: {}, inbox: {}, coverage: 'complete' }; }
function terminal(reason?: string): Status {
  if (reason === 'completed' || reason === 'stop' || reason === 'tool-calls') return 'completed';
  if (reason === 'error') return 'error';
  if (reason === 'aborted') return 'cancelled';
  if (reason === 'max-tokens') return 'truncated';
  if (reason === 'blocked') return 'blocked';
  return 'unknown';
}

export function fold(state: FoldState, info: SessionInfo, event: EventSummary, namespace: string): { runs: Run[]; nodes: Node[] } {
  const runs: Run[] = []; const nodes: Node[] = [];
  if (event.seq <= state.watermark) return { runs, nodes };
  if (event.seq !== state.watermark + 1) throw new Error('Non-contiguous Session event sequence');
  if (!event.known && !event.ignorable) throw new Error('Unknown required event vocabulary');
  if (info.version !== 4) throw new Error('Unsupported Session format');
  if (Object.keys(state.open).length > 4096 || (state.run?.messageIds.length ?? 0) >= 1000) throw new Error('Open nodes or message identities exceed supported bound');
  if (event.configuration) state.configuration = event.configuration;
  state.watermark = event.seq;
  if (event.seq < info.inheritedEventCount) return { runs, nodes };
  const key = `${namespace}:${createHash('sha256').update(info.id).digest('base64url')}`;
  const node = (kind: Node['kind'], identity: string, label: string, parentId = state.step?.id ?? state.run?.id ?? null): Node => ({
    id: `${key}:${createHash('sha256').update(identity).digest('base64url')}`, sessionId: info.id, runId: state.run?.id ?? null, parentId, kind, label,
    status: 'running', startTime: event.time, timeSource: 'event', sourceSeq: event.seq, step: event.step ?? state.step?.step, revision: 0,
  });
  const close = (item: Node | null | undefined, status: Status = 'completed') => {
    if (!item) { state.coverage = 'partial'; return; }
    item.status = status; item.endTime = event.time; item.endSeq = event.seq; nodes.push({ ...item });
  };
  const openKey = (kind: string, id?: string) => `${kind}:${event.turn ?? state.run?.turn}:${event.step ?? state.step?.step}:${id}`;
  const take = (id: string) => { const item = state.open[id]; delete state.open[id]; return item; };
  if (!event.known) state.coverage = 'partial';
  switch (event.type) {
    case 'turn/start':
      if (state.run?.status === 'running') { state.run.status = 'unknown'; state.run.coverage = 'partial'; runs.push({ ...state.run }); }
      state.run = { id: `${key}:turn:${event.seq}`, sessionId: info.id, agentId: info.agentId, turn: event.turn!, startSeq: event.seq,
        startTime: event.time, status: 'running', taskOutcome: 'not_evaluated', models: [], requestIds: [], messageIds: [], usage: null,
        configuration: state.configuration, usageComplete: true, attempts: 0, retries: 0, tools: 0, errors: 0, revision: 0, coverage: state.coverage };
      state.step = null;
      break;
    case 'turn/end':
      if (!state.run || state.run.turn !== event.turn) { state.coverage = 'partial'; break; }
      state.run.status = terminal(event.reason); state.run.stopReason = event.reason;
      state.run.endTime = event.time; state.run.endSeq = event.seq;
      for (const [id, item] of Object.entries(state.open)) {
        if (item.runId !== state.run.id) continue;
        item.status = 'unknown'; nodes.push({ ...item }); delete state.open[id];
      }
      if (state.step?.status === 'running') { state.step.status = 'unknown'; nodes.push({ ...state.step }); }
      break;
    case 'step/start':
      state.step = node('step', `step:${event.turn}:${event.step}`, `Step ${event.step}`, state.run?.id ?? null);
      nodes.push({ ...state.step }); break;
    case 'step/end': close(state.step); break;
    case 'assistant/message': case 'assistant/attempt': {
      const item = node('attempt', `attempt:${event.seq}`, event.model ?? 'Model attempt');
      item.status = terminal(event.finishReason); item.model = event.model ?? (typeof state.configuration?.model === 'string' ? state.configuration.model : undefined); item.usage = event.usage;
      item.startTime = event.streamStart ?? null; item.endTime = event.streamEnd ?? event.time;
      item.timeSource = event.streamStart === undefined ? 'event' : 'stream'; nodes.push(item);
      if (state.run) {
        state.run.attempts++;
        if (!event.usage) state.run.usageComplete = false;
        else {
          state.run.usage ??= { inputTokens: 0, outputTokens: 0 };
          for (const [key, count] of Object.entries(event.usage)) {
            const field = key as keyof Usage;
            state.run.usage[field] = (state.run.usage[field] ?? 0) + count;
          }
        }
        if (item.status === 'error') state.run.errors++;
        if (item.model && !state.run.models.includes(item.model)) state.run.models.push(item.model);
      }
      break;
    }
    case 'tool/call': case 'tool/ptc-dispatch-start': {
      const parent = event.parentCallId ? state.open[openKey('tool', event.parentCallId)]?.id : undefined;
      const item = node('tool', `tool:${state.run?.turn}:${state.step?.step}:${encodeURIComponent(event.callId!)}`, event.name ?? 'Tool', parent);
      item.callId = event.callId;
      if (event.parentCallId && !parent) { item.parentId = null; state.coverage = 'partial'; }
      state.open[openKey('tool', event.callId)] = item; nodes.push({ ...item });
      if (state.run) state.run.tools++; break;
    }
    case 'tool/result': case 'tool/ptc-dispatch': {
      if (event.replacementEvent) break;
      const item = take(openKey('tool', event.callId));
      if (item) { item.error = event.error; close(item, event.reason === 'TOOL_OUTCOME_UNKNOWN' || event.reason === 'TOOL_NOT_STARTED' ? 'unknown' : event.isError ? 'error' : 'completed'); }
      else {
        const orphan = node('tool', `orphan:${event.seq}`, 'Unmatched tool result', null);
        orphan.status = 'unknown'; orphan.startTime = null; orphan.endTime = event.time; orphan.callId = event.callId; nodes.push(orphan); state.coverage = 'partial';
      }
      if (state.run && event.isError) state.run.errors++; break;
    }
    case 'llm/retry': {
      const item = node('retry', `retry:${event.retryId}`, 'Retry wait');
      state.open[`retry:${event.retryId}`] = item; nodes.push({ ...item }); if (state.run) state.run.retries++; break;
    }
    case 'llm/retry-started': close(take(`retry:${event.retryId}`)); break;
    case 'compaction/start': {
      const item = node('compaction', `compaction:${event.compactionId}`, 'Compaction', event.turn === null ? null : state.run?.id);
      if (event.turn === null) item.runId = null;
      state.open[`compact:${event.compactionId}`] = item; nodes.push({ ...item }); break;
    }
    case 'compaction/summary': {
      const item = state.open[`compact:${event.compactionId}`];
      if (item) { item.model = event.model; item.usage = event.usage; item.summarySeq = event.seq; item.replacement = event.replacement; nodes.push({ ...item }); } break;
    }
    case 'compaction/end': close(take(`compact:${event.compactionId}`), event.error ? 'error' : 'completed'); break;
    case 'compaction/prune': {
      const item = node('prune', `prune:${event.seq}`, 'Model-free prune', state.run?.status === 'running' ? undefined : null); item.status = 'completed'; item.endTime = event.time; if (state.run?.status !== 'running') item.runId = null; item.replacement = event.replacement; nodes.push(item); break;
    }
    case 'subagent/catalog': {
      const item = node('subagent', `child:${event.seq}`, event.childId ?? 'Related session', null);
      item.childId = event.childId; item.status = 'unknown'; nodes.push(item); break;
    }
    case 'request/header': if (state.run) state.run.configuration = event.configuration; break;
    case 'agent/inbox/spliced':
      for (const message of event.inserted ?? []) {
        if (Object.keys(state.inbox).length >= 1000) { state.coverage = 'partial'; break; }
        state.inbox[message.messageId] = { time: event.time, requestId: message.requestId };
      }
      break;
    case 'user/message':
      if (state.run?.status === 'running' && event.messageId) {
        const pending = state.inbox[event.messageId];
        const requestId = event.requestId ?? pending?.requestId;
        if (!state.run.messageIds.includes(event.messageId)) state.run.messageIds.push(event.messageId);
        if (requestId && !state.run.requestIds.includes(requestId)) state.run.requestIds.push(requestId);
        if (pending && event.time >= pending.time) { state.run.queueWaits ??= {}; state.run.queueWaits[event.messageId] = event.time - pending.time; }
        delete state.inbox[event.messageId];
      }
      break;
    default:
      if (!event.known || event.type.startsWith('tool-workflow/')) {
        const item = node('event', `event:${event.seq}`, event.type, null); item.status = 'unknown'; nodes.push(item); state.coverage = 'partial';
      }
      break;
  }
  if (state.run) { state.run.agentId ??= info.agentId; state.run.coverage = state.coverage; runs.push({ ...state.run }); }
  return { runs, nodes };
}
