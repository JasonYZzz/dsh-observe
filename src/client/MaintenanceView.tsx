import { useState } from 'react';
import { Button } from '@deepseek-ai/dsh-client-ui-primitives';
import type { NodePage } from '../types.js';
import type { Api } from './api.js';
import type { Text } from './locales.js';
import { useQuery } from './useQuery.js';
import { StatusTag, nodeLabel } from './format.js';
export function MaintenanceView({ request, t, sessionId }: { request: Api; t: Text; sessionId: string }) {
  const [cursor, setCursor] = useState<string>();
  const [seq, setSeq] = useState<number>();
  const nodes = useQuery<NodePage>(request, 'runs.nodes', { sessionId, standalone: true, limit: 50, cursor });
  const source = useQuery<unknown>(request, 'events.get', { sessionId, seq }, seq !== undefined);
  if (!nodes.error && !nodes.data?.items.length) return null;
  return <section><h2>{t('maintenance')}</h2>{nodes.error && <p role="alert">{nodes.error} <Button onClick={nodes.refresh}>{t('retry')}</Button></p>}
    {nodes.data?.items.map((node) => <details key={node.id}><summary>{nodeLabel(node,t)} · <StatusTag status={node.status} t={t} /> · seq {node.sourceSeq}</summary>
      <pre>{JSON.stringify({ model: node.model, usage: node.usage, replacement: node.replacement }, null, 2)}</pre>
      {[node.sourceSeq, node.summarySeq, node.endSeq].filter((seq): seq is number => seq !== undefined).map((seq) => <Button key={seq} onClick={() => setSeq(seq)}>{t('source')} · {seq}</Button>)}</details>)}
    {nodes.data && <nav className="observe-pagination" aria-label={t('maintenance')}><Button disabled={!cursor} onClick={() => setCursor(undefined)}>{t('first')}</Button><Button disabled={!nodes.data.nextCursor} onClick={() => setCursor(nodes.data!.nextCursor!)}>{t('next')}</Button></nav>}
    {seq !== undefined && <><p>{t('sourceHint')}</p>{source.error ? <p role="alert">{source.error}</p> : <pre tabIndex={0} aria-label={t('source')}>{source.data ? JSON.stringify(source.data, null, 2) : t('loading')}</pre>}</>}
  </section>;
}
