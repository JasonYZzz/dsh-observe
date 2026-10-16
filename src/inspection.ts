import { foldSurface, deriveEventMessage, type SessionEvent } from '@deepseek-ai/dsh-session';
import type { Node, Run } from './types.js';
import { inspectSerialize, safeText } from './policy.js';

export const contentCategories = ['system', 'user', 'context', 'assistant', 'tool', 'event'] as const;
export type ContentCategory = typeof contentCategories[number];
export interface ContentRef { category: ContentCategory; sourceKind?: string; form?: string; seq: number; part: 'message' | 'arguments' | 'configuration' | 'tool' | 'event'; index?: number; label: string; role: string; preview: string }
export interface Inspection {
  anchorSeq: number; inputSeq: number; configuration: unknown; contextStatus: 'reconstructed' | 'unavailable';
  contextReason?: string; categoryCounts: Partial<Record<ContentCategory, number>>; contextFilteredCount: number; injections: ContentRef[]; contextCount: number; toolCount: number; context: ContentRef[]; tools: ContentRef[];
  input: ContentRef[]; output: ContentRef[]; source: ContentRef[]; title?: string;
}
const record = (value: unknown): Record<string, any> => value && typeof value === 'object' ? value as Record<string, any> : {};
export function eventValue(event: SessionEvent, part: ContentRef['part'], index?: number): unknown {
  const data = record(event.data); const message = data.message ?? data;
  if (part === 'message') return message.content ?? data.summary ?? data.error ?? data;
  if (part === 'arguments') { const raw = data.arguments; if (typeof raw === 'string') { try { return JSON.parse(raw); } catch { return raw; } } return raw; }
  if (part === 'configuration') return data.header;
  if (part === 'tool') return data.header?.tools?.[index ?? 0];
  return event;
}
export function preview(event: SessionEvent): string {
  const value = eventValue(event, ['tool/call', 'tool/ptc-dispatch-start'].includes(event.type) ? 'arguments' : 'message');
  const text = Array.isArray(value) ? value.slice(0, 3).map((entry) => entry.text ?? (entry.type === 'tool-call' ? `${entry.name} ${entry.arguments}` : `[${entry.type}]`)).join(' ') : typeof value === 'string' ? value : JSON.stringify(value);
  return inspectSerialize(text ?? '', 2048).text.replace(/\s+/g, ' ').slice(0, 180);
}
function ref(event: SessionEvent, part: ContentRef['part'] = 'message', index?: number, projected?: unknown): ContentRef {
  const data = record(event.data); const message = record(projected ?? data.message ?? data);
  const role = message.role ?? (event.type === 'assistant/attempt' ? 'assistant' : event.type);
  const tool = part === 'tool' ? data.header?.tools?.[index ?? 0] : undefined;
  const sourceKind = message.source?.kind;
  // Protocol user/developer messages can carry producer-supplied context, as in native Trajectory.
  const category: ContentCategory = part === 'tool' || part === 'arguments' || event.type.startsWith('tool/') ? 'tool'
    : role === 'user' ? (sourceKind === 'user' ? 'user' : 'context')
    : role === 'developer' ? 'context' : ['system', 'assistant'].includes(role) ? role : 'event';
  return { seq: event.seq, part, index, role, category, sourceKind, form: message.source?.form, label: tool?.name ?? data.name ?? message.source?.kind ?? role, preview: tool?.description ? safeText(tool.description).slice(0, 180) : preview(event) };
}
export function inspect(events: readonly SessionEvent[], run: Run, node?: Node, section: 'context' | 'tools' = 'context', offset = 0, limit = 30, category?: ContentCategory): Inspection {
  const end = run.endSeq ?? events.length - 1;
  const candidates = events.slice(run.startSeq, end + 1);
  const target = events[node?.sourceSeq ?? run.startSeq];
  if (!target) throw new Error('inspection_source_missing');
  if (node && !['attempt', 'tool', 'step'].includes(node.kind)) {
    const output = events[node.summarySeq ?? node.sourceSeq] ?? target;
    const details = record(output.data);
    return { anchorSeq: target.seq, inputSeq: target.seq, configuration: JSON.parse(inspectSerialize(node.kind === 'compaction' ? { model: details.model, provider: details.provider } : null).text),
      categoryCounts: {}, contextFilteredCount: 0, injections: [], contextStatus: 'unavailable', contextReason: 'This event does not record an ordinary model request input.', contextCount: 0, toolCount: 0, context: [], tools: [], input: [],
      output: [ref(output, node.kind === 'compaction' && node.summarySeq !== undefined ? 'message' : 'event')], source: [ref(target, 'event'), ...(output.seq !== target.seq ? [ref(output, 'event')] : [])] };
  }
  const step = node?.step;
  const settled = node?.kind === 'tool'
    ? candidates.findLast((event) => event.type === 'assistant/message' && event.seq < target.seq && record(event.data).step === step)
    : candidates.find((event) => ['assistant/message', 'assistant/attempt'].includes(event.type) && (step === undefined || record(event.data).step === step));
  const anchor = node?.kind === 'attempt' ? target : settled ?? target;
  const cut = settled || node?.kind === 'attempt' ? anchor.seq : node?.kind === 'tool' ? target.seq : end + 1;
  const prefix = events.slice(0, cut);
  const header = prefix.findLast((event) => event.type === 'request/header');
  const toolDefs = record(record(header?.data).header).tools ?? [];
  let context: ContentRef[] = []; let contextReason: string | undefined;
  try {
    const surface = foldSurface(prefix);
    context = surface.nodes.flatMap((seq) => { const event = events[seq]; const message = deriveEventMessage(event, surface.projectedMessages); return message ? [ref(event, 'message', undefined, message)] : []; });
  } catch { contextReason = 'Historical message projection is unavailable; inspect source events for this request.'; }
  const input = node?.kind === 'tool' ? [ref(target, 'arguments')] : context.filter((item) => item.category === 'user' && item.seq >= run.startSeq);
  const injections = node?.kind === 'tool' ? [] : context.filter((item) => item.category === 'context' && item.seq >= run.startSeq);
  const categoryCounts: Inspection['categoryCounts'] = {};
  for (const item of context) categoryCounts[item.category] = (categoryCounts[item.category] ?? 0) + 1;
  const filtered = category ? context.filter((item) => item.category === category) : context;
  const outputEvent = node?.kind === 'tool' ? events[node.endSeq ?? -1] : node?.kind === 'attempt' ? target : settled;
  const sourceEvents = [target, ...(outputEvent && outputEvent.seq !== target.seq ? [outputEvent] : [])];
  const titleEvent = events.findLast((event) => event.type === 'session/title');
  return { anchorSeq: target.seq, inputSeq: cut, configuration: JSON.parse(inspectSerialize(record(header?.data).header?.config ?? run.configuration ?? null).text),
    categoryCounts, contextFilteredCount: filtered.length, injections, contextStatus: contextReason ? 'unavailable' : 'reconstructed', contextReason, contextCount: context.length, toolCount: toolDefs.length,
    context: section === 'context' ? filtered.slice(offset, offset + limit) : [],
    tools: section === 'tools' && header ? toolDefs.slice(offset, offset + limit).map((_: unknown, index: number) => ref(header, 'tool', offset + index)) : [],
    input, output: outputEvent ? [ref(outputEvent)] : [], source: sourceEvents.map((event) => ref(event, 'event')),
    title: typeof record(titleEvent?.data).title === 'string' ? safeText(record(titleEvent?.data).title) : undefined };
}
export function contentPage(event: SessionEvent, part: ContentRef['part'], index: number | undefined, offset: number, limit: number) {
  const result = inspectSerialize(eventValue(event, part, index));
  return { text: result.text.slice(offset, offset + limit), offset, total: result.text.length, nextOffset: offset + limit < result.text.length ? offset + limit : null, truncated: result.truncated, contentPolicy: 'redacted-content' };
}
