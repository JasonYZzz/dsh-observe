export const VERSION = '0.2.2';
export const HOST_VERSION = '0.2.0-rc.2';
export const PREFIX = 'dsh-observe/';
export type Status = 'running' | 'completed' | 'error' | 'cancelled' | 'truncated' | 'blocked' | 'unknown';
export interface Usage { inputTokens: number; outputTokens: number; totalTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number; reasoningTokens?: number }
export interface Run {
  id: string; sessionId: string; agentId: string | null; turn: number; startSeq: number; endSeq?: number;
  startTime: number; endTime?: number; status: Status; stopReason?: string; taskOutcome: 'not_evaluated';
  configuration?: Record<string, string | number | boolean>; queueWaits?: Record<string, number>;
  models: string[]; requestIds: string[]; messageIds: string[]; usage: Usage | null; usageComplete: boolean;
  attempts: number; retries: number; tools: number; errors: number; revision: number; coverage: 'complete' | 'partial';
}
export interface Node {
  id: string; sessionId: string; runId: string | null; parentId: string | null;
  kind: 'step' | 'attempt' | 'tool' | 'retry' | 'subagent' | 'compaction' | 'prune' | 'event';
  label: string; status: Status; startTime: number | null; endTime?: number; timeSource: 'event' | 'stream' | 'local-observed';
  sourceSeq: number; endSeq?: number; step?: number; callId?: string; childId?: string; model?: string;
  usage?: Usage; error?: string; revision: number;
  preview?: string; summarySeq?: number; replacement?: { start: number; end: number; count: number };
}
export interface EventSummary {
  seq: number; time: number; type: string; known: boolean; ignorable?: boolean; replacementEvent?: boolean;
  turn?: number | null; step?: number; callId?: string; parentCallId?: string; compactionId?: string; retryId?: string;
  name?: string; isError?: boolean; error?: string; reason?: string; model?: string; childId?: string;
  requestId?: string; messageId?: string; inserted?: { messageId: string; requestId?: string }[];
  configuration?: Record<string, string | number | boolean>;
  streamStart?: number; streamEnd?: number; finishReason?: string; usage?: Usage;
  replacement?: { start: number; end: number; count: number };
}
export interface SessionInfo {
  id: string; version: number; inheritedEventCount: number; agentId: string | null; parentSession?: string;
}
export interface FoldState {
  configuration?: Record<string, string | number | boolean>;
  watermark: number; run: Run | null; step: Node | null; open: Record<string, Node>;
  inbox: Record<string, { time: number; requestId?: string }>; coverage: 'complete' | 'partial';
}
export interface Binding {
  sessionId: string; requestId?: string; messageId?: string; userId: string; tenantId?: string;
  agentDefinitionId?: string; agentVersion?: string; sourcePlugin: string;
}
export interface Log {
  id?: number; time: number; level: string; source: string; summary: string;
  sessionId: string | null; runId: string | null; nodeId: string | null; nativeTurn?: number; nativeStep?: number; nativeCallId?: string;
}
export interface Page<T> { items: T[]; nextCursor: string | null; asOfRevision: number }
export interface LogPage extends Page<Log> { scopeCount: number; unassociatedCount: number }
export interface Health {
  pluginVersion: string; hostVersion: string; nodeVersion: string;
  database: { status: 'ready'; schemaVersion: number; namespace: string; revision: number; bytes: number; walBytes: number };
  indexing?: { id: string; watermark: number; error: string | null }[];
  capture: { queued: number; droppedLogs: number; gaps: number; failedSessions: number };
  coverage: 'live-and-on-demand-history';
}

export interface RunDetails extends Run {
  links: { kind: string; sessionId: string; parentSession: string }[];
  contexts: (Binding & { boundAt: number; association: 'late' | 'prebound'; identitySource: 'trusted-plugin' })[];
  identitySource: 'trusted-plugin' | 'native-operator'; operatorId: string;
  sessionStatus?: { watermark: number; error: string | null };
}
export interface RunList extends Page<Run> {
  sessions: { id: string; createdAt: number; parentSession?: string; live: boolean; persisted: boolean }[];
  sessionListTruncated: boolean;
}
export interface NodePage extends Page<Node> { liveAttempts: { sessionId: string; turn: number; step: number; attemptId: string; observedAt: number; firstToken?: number; lastToken?: number; complete: boolean }[] }
