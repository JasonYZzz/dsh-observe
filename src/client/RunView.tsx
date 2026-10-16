import { useEffect, useState } from 'react';
import { Button, Input } from '@deepseek-ai/dsh-client-ui-primitives';
import type { Node, NodePage, RunDetails } from '../types.js';
import type { Inspection } from '../inspection.js';
import type { Api } from './api.js';
import type { Text } from './locales.js';
import { useQuery } from './useQuery.js';
import { StatusTag, duration, runUrl, time, sessionUrl, nodeLabel } from './format.js';
import { LogView } from './LogView.js';
import { ContentItem, categoryLabels } from './ContentViewer.js';
const tabs = ['overview', 'contextInput', 'toolCatalog', 'source', 'logs'] as const;
export function RunView({ request, t, runId }: { request: Api; t: Text; runId: string }) {
  const [cursor, setCursor] = useState<string>();
  const [selectedId, setSelectedId] = useState<string | undefined>(() => new URL(location.href).searchParams.get('observeNode') ?? undefined);
  const [tab, setTab] = useState<typeof tabs[number]>('overview'); const [sectionOffset, setSectionOffset] = useState(0);
  const [search, setSearch] = useState(''); const [role, setRole] = useState<keyof typeof categoryLabels | ''>(''); const [mobile, setMobile] = useState('tree');
  const run = useQuery<RunDetails>(request, 'runs.get', { runId }, true, (value) => value.status === 'running');
  const nodes = useQuery<NodePage>(request, 'runs.nodes', { runId, limit: 50, cursor }, true, (value) => value.liveAttempts.length > 0 || value.items.some((node) => node.status === 'running'));
  const selectedOnPage = nodes.data?.items.find((node) => node.id === selectedId);
  const located = useQuery<NodePage>(request, 'runs.nodes', { runId, nodeId: selectedId, limit: 1 }, Boolean(selectedId) && !selectedOnPage);
  const selected = selectedOnPage ?? located.data?.items.find((node) => node.id === selectedId);
  useEffect(() => { if (!selectedId && nodes.data?.items.length) setSelectedId((nodes.data.items.find((node) => node.kind === 'attempt') ?? nodes.data.items[0]).id); }, [nodes.data, selectedId]);
  const inspection = useQuery<Inspection>(request, 'requests.get', { runId, nodeId: selectedId, section: tab === 'toolCatalog' ? 'tools' : 'context', category: tab === 'contextInput' ? role || undefined : undefined, offset: sectionOffset, limit: 30 }, Boolean(selectedId), () => run.data?.status === 'running');
  const choose = (node: Node) => { setSelectedId(node.id); setTab('overview'); setSectionOffset(0); setRole(''); setMobile('details'); history.replaceState(history.state, '', runUrl(runId, node.id)); };
  if (run.error) return <p role="alert">{run.error} <Button onClick={run.refresh}>{t('retry')}</Button></p>;
  if (!run.data) return <p role="status">{t('loading')}</p>;
  const data = run.data; const info = inspection.data;
  const sectionCount = tab === 'toolCatalog' ? info?.toolCount ?? 0 : info?.contextFilteredCount ?? 0;
  const ordinary = !selected || ['attempt','step','tool'].includes(selected.kind);
  const content = (items: Inspection['input'], expanded = false) => items.length ? items.map((item) => <ContentItem key={`${selectedId}:${item.seq}:${item.part}:${item.index}`} request={request} t={t} sessionId={data.sessionId} item={item} expanded={expanded} />) : <p className="observe-empty-note">{t('notRecorded')}</p>;
  const visible = nodes.data?.items.filter((node) => !search || `${nodeLabel(node,t)} ${node.label} ${node.kind} ${node.preview ?? ''}`.toLowerCase().includes(search.toLowerCase())) ?? [];
  return <div className="observe-run-workspace">
    <div className="observe-run-facts"><StatusTag status={data.status} t={t} /><span>{t('turnNumber',{turn:data.turn})}</span><span>{duration(data.startTime, data.endTime)}</span><span>{data.attempts} {t('attempts')}</span><span>{data.tools} {t('toolsCount')}</span><span>{data.usage ? `${data.usage.inputTokens.toLocaleString()} / ${data.usage.outputTokens.toLocaleString()} Token` : t('noUsage')}{data.usage && !data.usageComplete && ` · ${t('partialUsage')}`}</span><small>{time(data.startTime)}</small></div>
    <div className="observe-mobile-tabs" role="tablist" aria-label={t('details')}>{(['tree','details'] as const).map((view) => <Button key={view} role="tab" aria-selected={mobile === view} onClick={() => setMobile(view)}>{t(view)}</Button>)}</div>
    <div className="observe-run-layout" data-mobile-view={mobile}>
      <section className="observe-node-pane" aria-label={t('tree')}><div className="observe-pane-title"><h2>{t('executionFlow')}</h2><small>{t('orderedBySource')}</small></div>
        <Input aria-label={t('searchCalls')} placeholder={t('searchCalls')} value={search} onChange={(event) => setSearch(event.target.value)} />
        {nodes.error && <p role="alert">{nodes.error} <Button onClick={nodes.refresh}>{t('retry')}</Button></p>}
        {!nodes.data && <p role="status">{t('loading')}</p>}
        <p className="observe-provenance">{t('callSearchHint')}</p><div className="observe-call-list">{visible.map((node) => {
          const whole = Math.max(1, (data.endTime ?? Date.now()) - data.startTime);
          const left = node.startTime === null ? 0 : Math.max(0, Math.min(100, (node.startTime - data.startTime) / whole * 100));
          const width = node.startTime === null ? 0 : Math.max(.5, Math.min(100 - left, ((node.endTime ?? data.endTime ?? Date.now()) - node.startTime) / whole * 100));
          return <button key={node.id} className={`observe-node-button ${node.kind === 'step' ? 'observe-step-row' : ''}`} data-kind={node.kind} aria-pressed={node.id === selectedId} onClick={() => choose(node)}>
            <span className="observe-call-heading"><span className="observe-kind">{t(node.kind === 'attempt' ? 'modelCall' : node.kind === 'tool' ? 'toolCall' : node.kind === 'step' ? 'step' : 'event')}</span><strong>{nodeLabel(node,t)}</strong><small>{duration(node.startTime, node.endTime)}</small></span>
            {node.kind !== 'step' && <span className="observe-call-preview">{node.preview || t('notRecorded')}</span>}
            <span className="observe-call-foot"><StatusTag status={node.status} t={t}/><small>seq {node.sourceSeq}{node.endSeq !== undefined ? `–${node.endSeq}` : ''}</small><span className="observe-track" title={t('timeline')}>{node.startTime !== null && <span className="observe-bar" data-status={node.status} style={{marginInlineStart:`${left}%`,width:`${width}%`}} />}</span></span>
          </button>;
        })}</div>
        {!visible.length && nodes.data && <p>{t('noNodes')}</p>}
        {nodes.data?.liveAttempts.map((frame) => <p key={frame.attemptId} role="status">{t('localStart')} · {t('stepNumber',{step:frame.step})}</p>)}
        <nav className="observe-pagination" aria-label={t('tree')}><Button disabled={!cursor} onClick={() => {setCursor(undefined);setSelectedId(undefined);}}>{t('first')}</Button><Button disabled={!nodes.data?.nextCursor} onClick={() => {setCursor(nodes.data!.nextCursor!);setSelectedId(undefined);}}>{t('next')}</Button></nav>
      </section>
      <section className="observe-inspector" aria-label={t('requestInspector')}>
        <div className="observe-inspector-heading"><div><h2>{selected ? nodeLabel(selected,t) : t('requestInspector')}</h2><p>{selected ? `${t('sourceSeq')} ${selected.sourceSeq} · ${t(selected.kind === 'attempt' ? 'modelCall' : selected.kind === 'tool' ? 'toolCall' : selected.kind === 'step' ? 'step' : 'event')}` : t('selectNode')}</p></div>{selected && <StatusTag status={selected.status} t={t} />}</div>
        <div className="observe-inspector-tabs" role="tablist" aria-label={t('requestInspector')}>{tabs.map((key) => <button key={key} role="tab" aria-selected={tab === key} onClick={() => {setTab(key);setSectionOffset(0);setRole('');}}>{t(key)}{key === 'contextInput' && info ? ` ${info.contextCount}` : key === 'toolCatalog' && info ? ` ${info.toolCount}` : ''}</button>)}</div>
        <div className="observe-inspector-body">
        {tab === 'logs' ? <LogView request={request} t={t} sessionId={data.sessionId} runId={runId} nodeId={selectedId} /> : <>
          {inspection.error && <p role="alert">{inspection.error} <Button onClick={inspection.refresh}>{t('retry')}</Button></p>}
          {!info && !inspection.error && <p role="status">{t('loading')}</p>}
          {info && tab === 'overview' && <><div className="observe-request-summary"><span><small>{t('model')}</small><strong>{String((info.configuration as any)?.model ?? selected?.model ?? (data.models.join(', ') || t('unknown')))}</strong></span><span><small>{t('duration')}</small><strong>{selected ? duration(selected.startTime, selected.endTime) : '—'}</strong></span>{(selected?.kind === 'attempt' || selected?.usage) && <><span><small>{t('inputTokens')}</small><strong>{selected?.usage?.inputTokens.toLocaleString() ?? t('noUsage')}</strong></span><span><small>{t('outputTokens')}</small><strong>{selected?.usage?.outputTokens.toLocaleString() ?? t('noUsage')}</strong></span></>}{selected?.usage?.cacheReadTokens !== undefined && <span><small>{t('cacheTokens')}</small><strong>{selected.usage.cacheReadTokens.toLocaleString()}</strong></span>}</div>
            {ordinary && <><h3>{selected?.kind === 'tool' ? t('toolArguments') : t('requestInput')}</h3>{content(info.input,true)}{selected?.kind !== 'tool' && info.injections.length > 0 && <><h3>{t('injectedContext')} · {info.injections.length}</h3><p className="observe-provenance">{t('injectedContextHelp')}</p>{content(info.injections)}</>}</>}
            <h3>{!ordinary ? t('eventDetails') : selected?.kind === 'tool' ? t('toolResult') : t('responseOutput')}</h3>{content(info.output,true)}
            {selected?.childId && <p><a href={sessionUrl(selected.childId)}>{t('relatedSession')}: {selected.childId}</a></p>}
            <details className="observe-metadata"><summary>{t('configuration')} · {t('identity')}</summary><pre>{JSON.stringify(info.configuration,null,2)}</pre><dl><dt>{t('sessionId')}</dt><dd>{data.sessionId}</dd><dt>{t('agentId')}</dt><dd>{data.agentId ?? t('missing')}</dd><dt>{t('requestId')}</dt><dd>{data.requestIds.join(', ')||t('missing')}</dd><dt>{t('userId')}</dt><dd>{data.contexts.map((value)=>`${value.userId} · ${value.sourcePlugin} · ${t(value.association)}`).join(', ')||t('missing')}</dd><dt>operator</dt><dd>{data.operatorId}</dd><dt>{t('stopReason')}</dt><dd>{data.stopReason??t('unknown')}</dd><dt>{t('outcome')}</dt><dd>{t('notEvaluated')}</dd></dl>{data.links.map((link)=><p key={link.parentSession}>{t('lineage')}: <a href={sessionUrl(link.parentSession)}>{link.parentSession}</a></p>)}</details>
          </>}
          {info && tab === 'contextInput' && <><p className="observe-provenance">{t('reconstructedContext')} · {t('beforeSeq')} {info.inputSeq}</p>{info.contextStatus === 'unavailable' && <p role="alert">{t('projectionUnavailable')}</p>}
            <div className="observe-role-filters">{(['', ...Object.keys(categoryLabels)] as typeof role[]).map((value) => <button key={value} aria-pressed={role===value} disabled={Boolean(value) && !info.categoryCounts[value as keyof typeof categoryLabels]} onClick={()=>{setRole(value);setSectionOffset(0);}}>{value ? t(categoryLabels[value]) : t('all')} <span>{value ? info.categoryCounts[value] ?? 0 : info.contextCount}</span></button>)}</div>{content(info.context)}
          </>}
          {info && tab === 'toolCatalog' && <><p className="observe-provenance">{t('recordedTools')}</p>{content(info.tools)}</>}
          {info && (tab === 'toolCatalog' || tab === 'contextInput') && <nav className="observe-pagination"><span>{sectionCount ? sectionOffset+1 : 0}–{Math.min(sectionOffset+30,sectionCount)} / {sectionCount}</span><Button disabled={!sectionOffset} onClick={()=>setSectionOffset(Math.max(0,sectionOffset-30))}>{t('previous')}</Button><Button disabled={sectionOffset+30 >= sectionCount} onClick={()=>setSectionOffset(sectionOffset+30)}>{t('next')}</Button></nav>}
          {info && tab === 'source' && <><p className="observe-provenance">{t('redactedSource')}</p>{content(info.source,true)}</>}
        </>}
        </div>
      </section>
    </div>
  </div>;
}
