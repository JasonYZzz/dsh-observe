import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-session';
import type {} from '@deepseek-ai/dsh-session-query';
import type {} from '@deepseek-ai/dsh-client-connection';
import { dshHomePath } from '@deepseek-ai/dsh-home-paths';
import { Store } from './store.js';
import { Capture } from './capture.js';
import { createHandler, createFetchHandler, endpoints } from './query.js';
import { bindingSchema } from './context.js';
import { HOST_VERSION, PREFIX, VERSION, type Binding, type Health } from './types.js';

export const name = 'dsh-observe';
export const inject = ['connection', 'sessions', 'sessionQuery'];
export interface ObserveService {
  health(): Promise<Health>;
  bindContext(binding: Binding): Promise<{ ok: boolean; error?: string }>;
}
declare module '@deepseek-ai/cordis' { interface Context { dshObserve: ObserveService } }

export async function apply(ctx: Context) {
  if (Number(process.versions.node.split('.')[0]) !== 24) throw new Error('dsh-observe requires the verified Node 24 runtime');
  const store = new Store(dshHomePath('storages', 'dsh-observe'));
  let ownedCapture: Capture | undefined;
  ctx.effect(() => async () => { await ownedCapture?.dispose(); await store.close(); }, 'dsh-observe: drain then close worker');
  await store.ready;
  const capture = new Capture(ctx, store);
  ownedCapture = capture;
  const service: ObserveService = {
    health: async () => {
      const [database, indexed] = await Promise.all([store.health(), store.call<{ failedSessions: number; sessions: Health['indexing'] }>('capture.health')]);
      return { pluginVersion: VERSION, hostVersion: HOST_VERSION, nodeVersion: process.versions.node, database,
        capture: { ...capture.health(), failedSessions: Math.max(capture.health().failedSessions, indexed.failedSessions) },
        indexing: indexed.sessions, coverage: 'live-and-on-demand-history' };
    },
    bindContext: async (binding) => {
      const parsed = bindingSchema.safeParse(binding);
      if (!parsed.success) return { ok: false, error: 'invalid_binding' };
      try { await store.call('context.bind', parsed.data); return { ok: true }; }
      catch (error) { return { ok: false, error: error instanceof Error && error.message === 'binding_conflict' ? 'binding_conflict' : 'binding_unavailable' }; }
    },
  };
  ctx.provide('dshObserve', service);
  const handle = createHandler({ health: service.health, store, capture, sessionQuery: ctx.sessionQuery });
  for (const endpoint of endpoints) ctx.effect(() => ctx.connection.fetch.register({ path: `/api/${PREFIX}${endpoint}`, methods: ['POST'], requestBody: 'streaming',
    fetch: createFetchHandler(endpoint, handle, ctx.connection.operator) }), `dsh-observe: ${endpoint}`);
}
