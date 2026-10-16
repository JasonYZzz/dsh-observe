// Synthetic, sanitized RC.2 contract fixtures; these are not real provider calls.
const start = ['turn/start', { turn: 1 }];
const step = ['step/start', { turn: 1, step: 1 }];
const stepEnd = ['step/end', { turn: 1, step: 1 }];
const end = (kind) => ['turn/end', { turn: 1, reason: { kind } }];
const tool = ['tool/call', { turn: 1, step: 1, callId: 'call-1', name: 'read_file', arguments: '{"path":"example.txt"}' }];
const result = (isError = false) => ['tool/result', { turn: 1, step: 1, message: { id: 'result-1', role: 'tool', source: { kind: 'tool', callId: 'call-1' }, toolCallId: 'call-1', isError, content: [{ type: 'text', text: isError ? 'File unavailable' : 'example' }] } }];
const attempt = ['assistant/attempt', { turn: 1, step: 1, stream: [{ type: 'chunk', time: 1002, chunk: { type: 'finish', reason: { kind: 'error', failure: { code: 'RATE_LIMIT', message: 'Synthetic 429' } } } }] }];
const answer = ['assistant/message', { turn: 1, step: 1,
  message: { id: 'answer-1', role: 'assistant', source: { kind: 'model', provider: 'fixture', model: 'fixture-model' }, content: [{ type: 'text', text: 'Example answer' }] },
  stream: [{ type: 'text-chunks', time0: 1005, index: 0, dt: [], texts: ['Example answer'] }, { type: 'chunk', time: 1006, chunk: { type: 'finish', reason: { kind: 'stop' } } }], usage: { inputTokens: 10, outputTokens: 3, totalTokens: 13 } }];
const toolAnswer = structuredClone(answer);
toolAnswer[1].message.content = [{ type: 'tool-call', id: 'call-1', name: 'read_file', arguments: '{"path":"example.txt"}' }];
toolAnswer[1].stream = [{ type: 'tool-call-chunks', time0: 1005, index: 0, dt: [], id: 'call-1', name: 'read_file', args: ['{"path":"example.txt"}'] }, { type: 'chunk', time: 1006, chunk: { type: 'finish', reason: { kind: 'tool-calls' } } }];
const nested = { rootCallId: 'call-1', parentCallId: 'call-1', subCallId: 'call-1:ptc:1', name: 'read_file', arguments: { path: 'example.txt' } };
function events(rows) {
  return rows.map(([type, data], seq) => ({ type, data: structuredClone(data), seq, time: 1000 + seq * 10,
    ...(['assistant/message', 'tool/result', 'user/message'].includes(type) ? { surfaceOp: 'append' } : {}) }));
}
export const fixtures = {
  success: events([start, step, toolAnswer, tool, result(), stepEnd, end('completed')]),
  failure: events([start, step, toolAnswer, tool, result(true), stepEnd, ['turn/end', { turn: 1, reason: { kind: 'error', error: { code: 'UNKNOWN', message: 'Synthetic failure' } } }]]),
  retry: events([start, step, ['request/header', { header: { config: { provider: 'fixture', model: 'fixture-model' } }, reason: 'initial' }], attempt, ['llm/retry', { retryId: 'retry-1', turn: 1, step: 1, provider: 'fixture', mode: 'normal', policyKey: 'default', retry: 1, maxRetries: 2, delayMs: 10, failure: { code: 'RATE_LIMIT', message: 'Synthetic 429' } }], ['llm/retry-started', { retryId: 'retry-1', turn: 1, step: 1, retry: 1 }], answer, stepEnd, end('completed')]),
  cancel: events([start, step, toolAnswer, tool, result(true), stepEnd, ['turn/end', { turn: 1, reason: { kind: 'aborted', reason: { kind: 'user' } } }]]),
  subagent: events([start, step, ['subagent/catalog', { version: 0, mode: 'one-shot', childId: 'fixture-child', childCreatedAt: 1001 }], stepEnd, end('completed')]),
  compaction: events([['compaction/start', { compactionId: 'compact-1', turn: null }], ['compaction/end', { compactionId: 'compact-1', turn: null, error: 'Synthetic summary failure' }]]),
  nested: events([start, step, toolAnswer, tool, ['tool/ptc-dispatch-start', nested], ['tool/ptc-dispatch', { ...nested, isError: false, content: [{ type: 'text', text: 'nested example' }] }], result(), stepEnd, end('completed')]),
  fork: events([start, step, answer, stepEnd, end('completed'), ['session/end-seed', { inherited: true }], ['turn/start', { turn: 2 }], ['turn/end', { turn: 2, reason: { kind: 'completed' } }]]),
  recovery: events([start, step, toolAnswer, tool, result(true), stepEnd, end('interrupted')]),
};

export function largeFixture(steps = 3334) {
  const rows = [structuredClone(fixtures.success[0])];
  for (let step = 1; step <= steps; step++) {
    const events = structuredClone(fixtures.success.slice(1, -1));
    for (const event of events) {
      event.data.step = step;
      if (event.type === 'assistant/message') {
        event.data.message.id = `answer-${step}`;
        event.data.message.content[0].id = `call-${step}`;
        event.data.stream[0].id = `call-${step}`;
      }
      if (event.type === 'tool/call') event.data.callId = `call-${step}`;
      if (event.type === 'tool/result') {
        event.data.message.id = `result-${step}`;
        event.data.message.toolCallId = `call-${step}`;
        event.data.message.source.callId = `call-${step}`;
        event.data.message.content[0].text = 'Synthetic tool output. '.repeat(190);
      }
      rows.push(event);
    }
  }
  rows.push(structuredClone(fixtures.success.at(-1)));
  return rows.map((event, seq) => ({ ...event, seq, time: 1000 + seq }));
}

fixtures.summary = [...structuredClone(fixtures.success), ...events([
  ['compaction/start', { compactionId: 'compact-ok', turn: null }],
  ['compaction/summary', { compactionId: 'compact-ok', provider: 'fixture', model: 'summary-model', summary: [{ type: 'text', text: 'Synthetic summary' }], usage: { inputTokens: 20, outputTokens: 5 }, shadowedRange: { start: 2, end: 4 }, shadowedSeqs: [2, 4], shadowedTokenCount: 20 }],
  ['user/message', { id: 'checkpoint-1', role: 'user', source: { kind: 'compact-checkpoint', compactionId: 'compact-ok' }, content: [{ type: 'text', text: 'Synthetic summary' }] }],
  ['compaction/end', { compactionId: 'compact-ok', turn: null }],
]).map((event, index) => ({ ...event, seq: 7 + index, time: 1070 + index * 10,
  ...(event.type === 'user/message' ? { surfaceOp: { op: 'replace', startSeq: 2, endSeq: 4 }, sourceEventSeqs: [7, 8, 2, 4] } : {}) }))];
fixtures.prune = [...structuredClone(fixtures.success.slice(0, -1)), ...events([
  ['compaction/prune', { shadowedRange: { start: 4, end: 4 }, shadowedSeqs: [4], shadowedTokenCount: 3 }],
  ['tool/result', { turn: 1, step: 1, message: { ...structuredClone(result()[1].message), id: 'result-1', content: [{ type: 'text', text: 'Output omitted' }] } }],
]).map((event, index) => ({ ...event, seq: 6 + index, time: 1060 + index * 10,
  ...(event.type === 'tool/result' ? { surfaceOp: { op: 'replace', startSeq: 4, endSeq: 4 }, sourceEventSeqs: [4] } : {}) })), { ...structuredClone(fixtures.success.at(-1)), seq: 8, time: 1080 }];

fixtures.request = events([start,step,
  ['request/header',{header:{config:{provider:'fixture',model:'fixture-model',maxTokens:4096},tools:[{name:'read_file',description:'Read a UTF-8 text file',parameters:{type:'object',properties:{path:{type:'string'}},required:['path']}}]},reason:'initial'}],
  ['system/message',{turn:1,step:1,message:{id:'system-request',role:'system',source:{kind:'system-prompt'},content:[{type:'text',text:'You are a synthetic assistant for request inspection.'}]}}],
  ['user/message',{id:'user-request',role:'user',source:{kind:'user',rpcId:'fixture-request-id'},content:[{type:'text',text:'Please read example.txt. api_key=fixture-secret-never-expose'}]}],
  toolAnswer,tool,result(),stepEnd,end('completed')]);
fixtures.request[3].surfaceOp='append';
fixtures.request[7].data.message.content[0].text='Synthetic fixture output. '.repeat(900)+'LAST PAGE VERIFIED';

// Producer context deliberately uses protocol user/developer roles, like native DSH.
const injected = [
  ['user/message', { id: 'approval-context', role: 'user', source: { kind: 'user-approval', form: 'notice', summary: 'Approval policy changed' }, content: [{ type: 'text', text: 'Synthetic approval settings' }] }],
  ['user/message', { id: 'runtime-context', role: 'user', source: { kind: 'runtime-context', form: 'snapshot', sections: [] }, content: [{ type: 'text', text: 'Synthetic runtime environment' }] }],
  ['developer/message', { turn: 1, step: 1, message: { id: 'developer-context', role: 'developer', source: { kind: 'skill-catalog', form: 'catalog' }, content: [{ type: 'text', text: 'Synthetic skill catalog' }] } }],
];
fixtures.classified = [...structuredClone(fixtures.request.slice(0, 4)), ...events(injected).map(event => ({ ...event, surfaceOp: 'append' })), ...structuredClone(fixtures.request.slice(4))].map((event, seq) => ({ ...event, seq, time: 1000 + seq * 10 }));
