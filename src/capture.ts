import type { Context, Message } from '@deepseek-ai/cordis';
import type { Session, SessionId } from '@deepseek-ai/dsh-session';
import type {} from '@deepseek-ai/dsh-session-query';
import type {} from '@deepseek-ai/dsh-agent';
import type { Store } from './store.js';
import { summarize } from './fold.js';
import { logSummary, safeText } from './policy.js';
import type { EventSummary, Log, SessionInfo } from './types.js';

type Job = { kind: 'event'; info: SessionInfo; event: EventSummary } | { kind: 'index'; id: string } | { kind: 'log'; log: Log } | { kind: 'inactive'; id: string };
interface Progress { sessionId: string; turn: number; step: number; attemptId: string; revision: number; index: number; observedAt: number; firstToken?: number; lastToken?: number; complete: boolean }
export class Capture {
  private queue: Job[] = [];
  private indexing = new Set<string>();
  private agents = new Map<string, string>();
  private frames = new Map<string, Progress>();
  private controller = new AbortController();
  private draining?: Promise<void>;
  private cold: Promise<unknown> = Promise.resolve();
  private stopped = false;
  private pendingReads = 0;
  droppedLogs = 0;
  gaps = 0;
  private failures = new Set<string>();
  constructor(private ctx: Context, private store: Store) {
    ctx.on('session/event', (session, event) => {
      try {
        if (!this.indexing.has(session.id)) this.schedule(session.id);
        this.push({ kind: 'event', info: this.info(session), event: summarize(event) });
      } catch { this.gaps++; this.failures.add(session.id); this.indexing.delete(session.id); this.schedule(session.id); }
    });
    ctx.on('session/created', (session) => this.schedule(session.id));
    ctx.on('session/disposed', (session) => { this.push({ kind: 'inactive', id: session.id }); this.agents.delete(session.id); this.indexing.delete(session.id); for (const [id, frame] of this.frames) if (frame.sessionId === session.id) this.frames.delete(id); });
    ctx.on('agent/assistant-stream', ({ agent, frame }) => {
      try {
        this.agents.set(agent.session.id, String(agent.id));
        const key = `${agent.session.id}:${frame.attemptId}`;
        if (frame.type === 'start') {
          if (this.frames.size >= 128) { this.frames.delete(this.frames.keys().next().value!); this.gaps++; }
          this.frames.set(key, { sessionId: agent.session.id, turn: frame.turn, step: frame.step, attemptId: frame.attemptId,
            revision: frame.revision, index: -1, observedAt: Date.now(), complete: true });
        } else if (frame.type === 'end') this.frames.delete(key);
        else {
          const current = this.frames.get(key);
          if (!current || frame.revision <= current.revision) return;
          if (frame.index !== current.index + 1) current.complete = false;
          current.index = frame.index; current.revision = frame.revision;
          if (frame.chunk.type === 'text-delta' || frame.chunk.type === 'reasoning-delta') {
            current.firstToken ??= frame.time; current.lastToken = frame.time;
          }
        }
      } catch { this.gaps++; }
    });
    ctx.on('agent/error', ({ agent, error, turn, step }) => { this.agents.set(agent.session.id, String(agent.id)); this.push({ kind: 'log', log: { time: Date.now(), level: 'error', source: 'agent/error', summary: logSummary(error),
      sessionId: agent.session.id, runId: null, nodeId: null, nativeTurn: turn, nativeStep: step } }); });
    ctx.logger.exporter({ levels: { default: 2 }, export: (message) => this.log(message) });
    for (const session of ctx.sessions.list()) this.schedule(session.id);
  }
  private info(session: Session): SessionInfo { return { id: session.id, version: session.header.version, inheritedEventCount: session.inheritedEventCount,
    agentId: this.agents.get(session.id) ?? null, parentSession: session.header.parentSession }; }
  private log(message: Message) {
    try {
      if (message.name === 'dsh-observe' || message.name.startsWith('dsh-observe:')) return;
      const tags = message as Message & { sessionId?: string; agentId?: string; turn?: number; step?: number; callId?: string };
      const sessionId = typeof tags.sessionId === 'string' ? tags.sessionId : [...this.agents].find(([, id]) => id === tags.agentId)?.[0] ?? null;
      this.push({ kind: 'log', log: { time: message.ts, level: message.type, source: safeText(message.name), summary: logSummary(message.args),
        sessionId, runId: null, nodeId: null, nativeTurn: tags.turn, nativeStep: tags.step, nativeCallId: tags.callId } });
    } catch { this.droppedLogs++; }
  }
  private push(job: Job) {
    if (this.stopped) return;
    if (this.queue.length >= 2048) {
      if (job.kind === 'log') this.droppedLogs++;
      else { const id = job.kind === 'event' ? job.info.id : job.id; this.gaps++; this.failures.add(id); this.indexing.delete(id); }
      return;
    }
    this.queue.push(job);
    if (!this.draining) {
      this.draining = new Promise<void>((resolve) => setImmediate(resolve)).then(() => this.drain()).finally(() => { this.draining = undefined; });
    }
  }
  private schedule(id: string) {
    if (this.indexing.has(id)) return;
    this.indexing.add(id); this.push({ kind: 'index', id });
  }
  private async drain() {
    while (this.queue.length) {
      const job = this.queue.shift()!;
      let lostLogs = job.kind === 'log' ? 1 : 0;
      try {
        if (job.kind === 'index') await this.ensure(job.id);
        else if (job.kind === 'inactive') await this.store.call('session.inactive', { sessionId: job.id });
        else if (job.kind === 'event') {
          const events = [job.event];
          while (events.length < 128 && this.queue[0]?.kind === 'event' && (this.queue[0] as Extract<Job, { kind: 'event' }>).info.id === job.info.id) {
            events.push((this.queue.shift() as Extract<Job, { kind: 'event' }>).event);
          }
          await this.store.call('batch', { info: job.info, events });
        } else {
          const logs = [job.log];
          while (logs.length < 100 && this.queue[0]?.kind === 'log') logs.push((this.queue.shift() as Extract<Job, { kind: 'log' }>).log);
          lostLogs = logs.length;
          await this.store.call('logs.add', logs);
        }
      } catch {
        if (job.kind === 'log') this.droppedLogs += lostLogs;
        else {
          this.gaps++;
          const id = job.kind === 'event' ? job.info.id : job.id;
          this.failures.add(id);
          this.indexing.delete(id);
          if (job.kind === 'event') {
            if (!this.queue.some((item) => item.kind === 'index' && item.id === id)) this.schedule(id);
          }
        }
      }
    }
  }
  ensure(id: string, signal?: AbortSignal): Promise<void> {
    if (this.pendingReads >= 64) return Promise.reject(new Error('index_queue_full'));
    this.pendingReads++;
    const work = this.cold.catch(() => {}).then(async () => {
      if (this.stopped) return;
      const control = signal ? AbortSignal.any([signal, this.controller.signal]) : this.controller.signal;
      control.throwIfAborted();
      let info: SessionInfo = { id, version: 4, inheritedEventCount: 0, agentId: this.agents.get(id) ?? null };
      try {
        const observation = await this.ctx.sessionQuery.observeSession(id as SessionId, { signal: control, projectionMode: 'none' });
        try {
          info = { ...info, version: observation.header.version, inheritedEventCount: observation.inheritedEventCount, parentSession: observation.header.parentSession };
          if (observation.events.length > 100_000) throw new Error('Session exceeds 100000 event limit; source remains unchanged');
          const stored = await this.store.call<{ indexedThroughSeq: number; error: string | null } | null>('session.get', { sessionId: id });
          let start = (stored?.indexedThroughSeq ?? -1) + 1;
          for (; start < observation.events.length; start += 128) {
            control.throwIfAborted();
            const events = observation.events.slice(start, start + 128).map(summarize);
            await this.store.call('batch', { info, events });
            await new Promise<void>((resolve) => setImmediate(resolve));
          }
          if (!observation.events.length || stored?.error) await this.store.call('batch', { info, events: [] });
          this.failures.delete(id);
        } finally { observation[Symbol.dispose](); }
      } catch (error) {
        if (control.aborted) throw error;
        this.failures.add(id);
        await this.store.call('session.error', { info, error: 'Session indexing failed or exceeded supported bounds; source is preserved' }).catch(() => {});
        throw error;
      }
    });
    const finished = work.finally(() => { this.pendingReads--; });
    this.cold = finished;
    return finished;
  }
  progress(sessionId: string, turn: number) { return [...this.frames.values()].filter((frame) => frame.sessionId === sessionId && frame.turn === turn); }
  health() { return { queued: this.queue.length + this.pendingReads, droppedLogs: this.droppedLogs, gaps: this.gaps, failedSessions: this.failures.size }; }
  async settle() { await this.draining; await this.cold.catch(() => {}); }
  async dispose() { this.stopped = true; this.controller.abort(); await this.draining; await this.cold.catch(() => {}); this.frames.clear(); }
}
