import { Tag } from '@deepseek-ai/dsh-client-ui-primitives';
import type { Node, Status } from '../types.js';
import type { Text } from './locales.js';
export function StatusTag({ status, t }: { status: Status; t: Text }) {
  return <Tag tone={status === 'error' ? 'danger' : ['truncated', 'unknown', 'blocked'].includes(status) ? 'warning' : status === 'completed' ? 'success' : 'neutral'}>{t(status)}</Tag>;
}
export const time = (value: number) => new Date(value).toLocaleString();
export function duration(start: number | null, end?: number): string {
  if (start === null || end === undefined || end < start) return '—';
  const ms = end - start; return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(2)} s`;
}
export function runUrl(runId?: string, nodeId?: string) {
  const url = new URL(location.href);
  url.searchParams.delete('token');
  if (runId) url.searchParams.set('observeRun', runId); else url.searchParams.delete('observeRun');
  if (nodeId) url.searchParams.set('observeNode', nodeId); else url.searchParams.delete('observeNode');
  return url.href;
}

export function sessionUrl(sessionId: string) {
  const url = new URL(runUrl()); url.searchParams.set('observeSession', sessionId); return url.href;
}

export function nodeLabel(node: Node, t: Text): string {
  if (node.kind === 'step') return t('stepNumber', { step: node.step ?? '?' });
  if (node.kind === 'retry') return t('retryWait');
  if (node.kind === 'compaction') return t('compaction');
  if (node.kind === 'prune') return t('prune');
  if (node.kind === 'attempt' && node.label === 'Model attempt') return node.model ?? t('modelCall');
  if (node.kind === 'tool' && node.label === 'Unmatched tool result') return t('unmatchedTool');
  if (node.kind === 'tool' && node.label === 'Tool') return t('toolCall');
  return node.label;
}
