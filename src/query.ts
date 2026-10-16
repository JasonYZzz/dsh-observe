import { z } from 'zod';
import { clientRequestSchema } from '@deepseek-ai/dsh-client-connection';
import type { ConnectionRpcHandler, PeerScope } from '@deepseek-ai/dsh-client-connection';
import type { SessionQueryEngine } from '@deepseek-ai/dsh-session-query';
import { SessionId, SessionSeq } from '@deepseek-ai/dsh-session';
import { idSchema } from './context.js';
import { redact } from './policy.js';
import { inspect, contentPage, preview, contentCategories, type ContentCategory } from './inspection.js';
import { summarize } from './fold.js';
import type { Capture } from './capture.js';
import type { Store } from './store.js';
import type { Health, Run } from './types.js';

const paging = { limit: z.number().int().min(1).max(200).default(50), cursor: z.string().max(4096).optional() };
const range = { from: z.number().int().nonnegative().optional(), to: z.number().int().nonnegative().optional() };
const status = z.enum(['running', 'completed', 'error', 'cancelled', 'truncated', 'blocked', 'unknown']);
export const schemas = {
  'requests.get': z.object({ runId: idSchema, nodeId: idSchema.optional(), section: z.enum(['context', 'tools']).default('context'), category: z.enum(contentCategories).optional(), offset: z.number().int().min(0).max(100000).default(0), limit: z.number().int().min(1).max(100).default(30) }).strict(),
  'content.get': z.object({ sessionId: idSchema, seq: z.number().int().nonnegative(), part: z.enum(['message', 'arguments', 'configuration', 'tool', 'event']), index: z.number().int().min(0).max(10000).optional(), offset: z.number().int().min(0).max(4000000).default(0), limit: z.number().int().min(1).max(65536).default(16384) }).strict(),
  'health.get': z.object({}).strict(),
  'runs.list': z.object({ ...paging, ...range, sessionId: idSchema.optional(), agentId: idSchema.optional(), requestId: idSchema.optional(),
    userId: idSchema.optional(), unbound: z.boolean().optional(), model: idSchema.optional(), status: status.optional() }).strict(),
  'runs.get': z.object({ runId: idSchema }).strict(),
  'runs.nodes': z.object({ ...paging, runId: idSchema.optional(), sessionId: idSchema.optional(), parentId: idSchema.optional(), nodeId: idSchema.optional(), standalone: z.boolean().optional(),
    afterRevision: z.number().int().nonnegative().optional() }).strict().refine((input) => Boolean(input.runId) !== Boolean(input.sessionId), 'Select Run or Session'),
  'logs.list': z.object({ ...paging, ...range, unassociated: z.boolean().optional(), sessionId: idSchema.optional(), runId: idSchema.optional(), nodeId: idSchema.optional(),
    level: z.enum(['error', 'warn', 'info', 'debug']).optional(), source: z.string().max(256).optional(), text: z.string().max(200).optional() }).strict(),
  'events.get': z.object({ sessionId: idSchema, seq: z.number().int().nonnegative(), before: z.number().int().min(0).max(10).default(0), after: z.number().int().min(0).max(10).default(0) }).strict(),
};
export const endpoints = Object.keys(schemas);
interface QueryService { health(): Promise<Health>; store: Store; capture: Capture; sessionQuery: SessionQueryEngine }
export function createHandler(service: QueryService): ConnectionRpcHandler {
  return async (endpoint, payload, signal, peer) => {
    if (signal.aborted) return failure('cancelled', 'Request cancelled');
    const schema = schemas[endpoint as keyof typeof schemas];
    if (!schema) return failure('not_found', 'Unknown observation endpoint');
    const parsed = schema.safeParse(payload ?? {});
    if (!parsed.success) return failure('invalid_input', 'Invalid observation query');
    const input = parsed.data as Record<string, unknown>;
    if (input.from !== undefined && input.to !== undefined && (Number(input.to) < Number(input.from) || Number(input.to) - Number(input.from) > 31 * 86400000)) {
      return failure('invalid_input', 'Time range must be ordered and at most 31 days');
    }
    try {
      let value: unknown;
      switch (endpoint) {
        case 'content.get': {
          const source = await service.sessionQuery.readEvent({ sessionId: SessionId(String(input.sessionId)), seq: SessionSeq(Number(input.seq)), before: 0, after: 0 }, signal);
          value = contentPage(source.target, input.part as any, input.index as number | undefined, Number(input.offset), Number(input.limit)); break;
        }
        case 'requests.get': {
          const run = await service.store.call<Run | null>('runs.get', { runId: input.runId });
          if (!run) return failure('not_found', 'Run not found');
          const nodes = input.nodeId ? await service.store.call<{ items: import('./types.js').Node[] }>('runs.nodes', { runId: input.runId, nodeId: input.nodeId, limit: 1 }) : null;
          if (input.nodeId && !nodes?.items[0]) return failure('not_found', 'Node not found in Run');
          const observation = await service.sessionQuery.observeSession(SessionId(run.sessionId), { signal, projectionMode: 'none' });
          try { value = inspect(observation.events, run, nodes?.items[0], input.section as 'context' | 'tools', Number(input.offset), Number(input.limit), input.category as ContentCategory | undefined); }
          finally { observation[Symbol.dispose](); }
          break;
        }
        case 'health.get': value = await service.health(); break;
        case 'runs.list': {
          if (input.sessionId) await service.capture.ensure(String(input.sessionId), signal);
          const result = await service.store.call<object>(endpoint, input);
          const sessions = await service.sessionQuery.listSessions(signal);
          value = { ...result, sessions: sessions.slice(0, 200).map(({ header, live, persisted }) => ({ id: header.id, createdAt: header.createdAt, parentSession: header.parentSession, live, persisted })), sessionListTruncated: sessions.length > 200 };
          break;
        }
        case 'runs.get': {
          value = await service.store.call<Run | null>(endpoint, input);
          if (!value) return failure('not_found', 'Run not found');
          value = { ...value as object, operatorId: String(peer.id) }; break;
        }
        case 'runs.nodes': {
          if (input.sessionId) await service.capture.ensure(String(input.sessionId), signal);
          const run = input.runId ? await service.store.call<Run | null>('runs.get', { runId: input.runId }) : null;
          if (input.runId && !run) return failure('not_found', 'Run not found');
          const result = await service.store.call<{ items: import('./types.js').Node[] }>(endpoint, input);
          if (run) {
            const observation = await service.sessionQuery.observeSession(SessionId(run.sessionId), { signal, projectionMode: 'none' });
            try { for (const node of result.items) { const event = observation.events[node.sourceSeq]; if (event) node.preview = preview(event); } } finally { observation[Symbol.dispose](); }
          }
          value = { ...result, liveAttempts: run ? service.capture.progress(run.sessionId, run.turn) : [] }; break;
        }
        case 'logs.list': value = await service.store.call(endpoint, input); break;
        case 'events.get': {
          const window = await service.sessionQuery.readEvent({ sessionId: SessionId(String(input.sessionId)), seq: SessionSeq(Number(input.seq)), before: Number(input.before), after: Number(input.after) }, signal);
          const metadata = (event: typeof window.target) => {
            const { error, ...fields } = summarize(event);
            return { ...fields, surfaceOp: event.surfaceOp, sourceEventSeqs: event.sourceEventSeqs };
          };
          value = { ...redact({ session: { id: window.session.id, version: window.session.version, createdAt: window.session.createdAt, parentSession: window.session.parentSession },
            inheritedEventCount: window.inheritedEventCount, target: metadata(window.target), events: window.events.map(metadata), startSeq: window.startSeq, endSeq: window.endSeq }, true) as object,
            contentPolicy: 'metadata-only', asOfRevision: (await service.health()).database.revision }; break;
        }
      }
      if (signal.aborted) return failure('cancelled', 'Request cancelled');
      return { ok: true, value };
    } catch (error) {
      if (signal.aborted) return failure('cancelled', 'Request cancelled');
      if (error instanceof Error && error.message === 'invalid_cursor') return failure('invalid_cursor', 'Cursor does not match query; reload the first page');
      return failure('unavailable', 'Observation data unavailable; retry after checking indexing and Host status');
    }
  };
}
function failure(code: string, message: string) { return { ok: false as const, error: { code, message, details: {} } }; }

export function createFetchHandler(endpoint: string, handle: ConnectionRpcHandler, peer: PeerScope) {
  return async (request: Request): Promise<Response> => {
    if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') return new Response('Expected JSON', { status: 415 });
    const reader = request.body?.getReader();
    if (!reader) return new Response('Missing body', { status: 400 });
    const chunks: Uint8Array[] = []; let size = 0;
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 16_384) { return new Response('Request too large', { status: 413 }); }
        chunks.push(value);
      }
      const body = clientRequestSchema.safeParse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      if (!body.success || body.data.method !== `dsh-observe/${endpoint}`) return new Response('Invalid RPC envelope', { status: 400 });
      const result = await handle(endpoint, body.data.payload, request.signal, peer);
      return Response.json({ type: 'server-response', rpcId: body.data.rpcId, result });
    } catch { return new Response('Invalid observation request', { status: 400 }); }
    finally { reader.releaseLock(); }
  };
}
