import { useEffect, useState } from 'react';
import { Button, Input } from '@deepseek-ai/dsh-client-ui-primitives';
import type { Api } from './api.js';
import type { Text } from './locales.js';
import { VERSION, type Health, type RunList } from '../types.js';
import { useQuery } from './useQuery.js';
import { RunView } from './RunView.js';
import { LogView } from './LogView.js';
import { MaintenanceView } from './MaintenanceView.js';
import { StatusTag, duration, runUrl, time } from './format.js';
interface NativeSession { id: string; title?: string; displayTitle: string; cwd?: string; updatedAt: number; blank: boolean; running: boolean }
interface NativeCatalog { ids: string[]; byId: Record<string, NativeSession> }
type UseSessions = <T>(selector: (state: NativeCatalog) => T) => T;
const emptyCatalog: NativeCatalog = { ids: [], byId: {} };
const fallbackSessions: UseSessions = (selector) => selector(emptyCatalog);
export function ObservePage({ request, t, sessionId, openGlobal, useSessions = fallbackSessions }: { request: Api; t: Text; sessionId?: string; openGlobal: () => void; useSessions?: UseSessions }) {
  const native = useSessions((state) => state);
  const [selectedSession, setSelectedSession] = useState<string | undefined>(() => sessionId ?? new URL(location.href).searchParams.get('observeSession') ?? undefined);
  const [runId, setRunId] = useState<string | undefined>(() => sessionId ? undefined : new URL(location.href).searchParams.get('observeRun') ?? undefined);
  const [search, setSearch] = useState(''); const [sessionLimit, setSessionLimit] = useState(50); const [navOpen,setNavOpen] = useState(false);
  const [filters, setFilters] = useState<Record<string,unknown>>({}); const [cursor,setCursor] = useState<string>();
  const [mode,setMode] = useState('runs'); const [copied,setCopied] = useState('');
  const health = useQuery<Health>(request,'health.get',{});
  const runs = useQuery<RunList>(request,'runs.list',{...filters,...(selectedSession?{sessionId:selectedSession}:{}),limit:50,cursor},true,(value)=>value.items.some((run)=>run.status==='running'));
  const selectRun = (id?:string) => {setRunId(id);history.replaceState(history.state,'',runUrl(id));};
  const selectSession = (id:string) => {setSelectedSession(id);setRunId(undefined);setCursor(undefined);setNavOpen(false);setMode('runs'); const url=new URL(runUrl());url.searchParams.set('observeSession',id);history.replaceState(history.state,'',url);};
  useEffect(()=>{if(sessionId && sessionId!==selectedSession) selectSession(sessionId);},[sessionId]);
  useEffect(()=>{const pop=()=>{const url=new URL(location.href);setRunId(url.searchParams.get('observeRun')??undefined);if(!sessionId)setSelectedSession(url.searchParams.get('observeSession')??undefined);};window.addEventListener('popstate',pop);return()=>window.removeEventListener('popstate',pop);},[sessionId]);
  const sessions=native.ids.map((id)=>native.byId[id]).filter((value)=>value && !value.blank);
  const fallback=runs.data?.sessions.map((value)=>({id:value.id,displayTitle:value.id,title:undefined,cwd:undefined,updatedAt:value.createdAt,running:value.live,blank:false}))??[];
  const available=(sessions.length?sessions:fallback).filter((value)=>`${value.title??value.displayTitle} ${value.cwd??''} ${value.id}`.toLowerCase().includes(search.toLowerCase()));
  const selected=native.byId[selectedSession??''];
  return <section className="dsh-observe" aria-label={t('title')}>
    <header className="observe-header"><div><h1>{t('title')} <small>{VERSION}</small></h1><p>{t('workspaceDescription')}</p></div><div className="observe-actions">
      {!sessionId && <Button className="observe-nav-toggle" onClick={()=>setNavOpen(!navOpen)}>{t('sessions')}</Button>}
      {runId && <Button onClick={async()=>{try{await navigator.clipboard.writeText(runUrl(runId,new URL(location.href).searchParams.get('observeNode')??undefined));setCopied(t('copied'));}catch{setCopied(t('copyFailed'));}}}>{t('copy')}</Button>}
      {sessionId && <Button onClick={openGlobal}>{t('openGlobal')}</Button>}
      <Button onClick={()=>{runs.refresh();health.refresh();}}>{t('refresh')}</Button>
      <details className="observe-health"><summary>{t('health')}<span className="observe-health-dot" data-failed={Boolean(health.error||health.data?.capture.failedSessions||health.data?.capture.gaps)} /></summary><div>{health.error?<p role="alert">{health.error}</p>:health.data?<dl><dt>{t('plugin')}</dt><dd>{health.data.pluginVersion}</dd><dt>{t('database')}</dt><dd>{t('ready')} · schema {health.data.database.schemaVersion}</dd><dt>{t('gaps')} / {t('failedSessions')}</dt><dd>{health.data.capture.gaps} / {health.data.capture.failedSessions}</dd><dt>{t('queued')} / {t('dropped')}</dt><dd>{health.data.capture.queued} / {health.data.capture.droppedLogs}</dd></dl>:t('loading')}</div></details>
    </div></header>
    {copied&&<p role="status">{copied}</p>}
    <div className="observe-workspace" data-session-only={Boolean(sessionId)} data-nav-open={navOpen}>
      {!sessionId && <aside className="observe-session-pane" aria-label={t('sessions')}><div className="observe-pane-title"><h2>{t('sessions')}</h2><small>{available.length}</small></div>
        <Input aria-label={t('searchSessions')} placeholder={t('searchSessions')} value={search} onChange={(event)=>{setSearch(event.target.value);setSessionLimit(50);}} />
        <div className="observe-session-list">{available.slice(0,sessionLimit).map((value)=><button key={value.id} data-session-id={value.id} aria-pressed={selectedSession===value.id} onClick={()=>selectSession(value.id)}><strong>{value.title??value.displayTitle}</strong><span>{value.cwd?.split('/').filter(Boolean).at(-1)??t('session')}<small>{new Date(value.updatedAt).toLocaleDateString()}</small></span>{value.running&&<small>{t('running')}</small>}</button>)}</div>
        {available.length>sessionLimit&&<Button onClick={()=>setSessionLimit(sessionLimit+50)}>{t('loadMore')}</Button>}
        {!available.length&&<p>{t('noSessions')}</p>}
        <details className="observe-manual-session"><summary>{t('enterSession')}</summary><form onSubmit={(event)=>{event.preventDefault();const id=String(new FormData(event.currentTarget).get('sessionId')??'').trim();if(id)selectSession(id);}}><Input aria-label={t('sessionId')} name="sessionId" maxLength={1024} required/><Button type="submit">{t('open')}</Button></form></details>
      </aside>}
      <main className="observe-main"><div className="observe-session-heading"><div><h2 title={selectedSession}>{selected?.title??selected?.displayTitle??(selectedSession?t('sessionExecution'):t('recentExecutions'))}</h2><small>{selected?.cwd??selectedSession??t('chooseSessionHelp')}</small></div><div className="observe-mode-tabs"><button aria-pressed={mode==='runs'} onClick={()=>setMode('runs')}>{t('runs')}</button><button aria-pressed={mode==='logs'} onClick={()=>setMode('logs')}>{t('operationalLogs')}</button></div></div>
      {mode==='logs'?<div className="observe-main-scroll"><LogView request={request} t={t} sessionId={selectedSession}/></div>:<>
        <div className="observe-run-picker"><label>{t('runs')}<select aria-label={t('chooseRun')} value={runId??''} onChange={(event)=>selectRun(event.target.value||undefined)}><option value="">{t('executionOverview')}</option>{runs.data?.items.map((run)=><option key={run.id} value={run.id}>{t('turnNumber',{turn:run.turn})} · {time(run.startTime)} · {run.models.join(', ')||t('unknown')} · {t(run.status)}</option>)}</select></label>
          <details className="observe-advanced-filters"><summary>{t('advancedFilters')}</summary><form onSubmit={(event)=>{event.preventDefault();const fields=new FormData(event.currentTarget);setFilters(Object.fromEntries([...fields].filter(([,v])=>v).map(([k,v])=>[k,k==='from'||k==='to'?new Date(String(v)).getTime():k==='unbound'?true:v])));setCursor(undefined);}}><label>{t('status')}<select name="status"><option value="">{t('all')}</option>{(['running','completed','error','cancelled','truncated','blocked','unknown'] as const).map((status)=><option key={status} value={status}>{t(status)}</option>)}</select></label>{(['model','requestId','userId','agentId'] as const).map((key)=><label key={key}>{t(key)}<Input name={key}/></label>)}{(['from','to'] as const).map((key)=><label key={key}>{t(key)}<Input type="datetime-local" name={key}/></label>)}<label><input type="checkbox" name="unbound"/>{t('unbound')}</label><Button type="submit">{t('filter')}</Button><Button type="reset" onClick={()=>setFilters({})}>{t('reset')}</Button></form></details>
        </div>
        {runId?<RunView key={runId} request={request} t={t} runId={runId}/>:<div className="observe-main-scroll"><h3 className="observe-list-heading">{t('executionOverview')}</h3>
          {runs.error&&<p role="alert">{runs.error} <Button onClick={runs.refresh}>{t('retry')}</Button></p>}
          {!runs.data&&!runs.error&&<p role="status">{t('loading')}</p>}
          {runs.data&&!runs.data.items.length&&<div className="observe-empty"><h3>{selectedSession?t('empty'):t('startHere')}</h3><p>{selectedSession?t('emptyHelp'):t('chooseSessionHelp')}</p></div>}
          <div className="observe-run-list">{runs.data?.items.map((run)=><a key={run.id} href={runUrl(run.id)} onClick={(event)=>{if(event.metaKey||event.ctrlKey)return;event.preventDefault();selectRun(run.id);}}><div><strong>{t('turnNumber',{turn:run.turn})}</strong><StatusTag status={run.status} t={t}/><span>{run.models.join(', ')||t('unknown')}</span><small>{time(run.startTime)}</small></div><p><span>{run.attempts} {t('modelCall')} · {run.tools} {t('toolCall')} · {duration(run.startTime,run.endTime)}</span><span>{run.usage?`${run.usage.inputTokens.toLocaleString()} / ${run.usage.outputTokens.toLocaleString()} Token`:t('noUsage')}</span></p></a>)}</div>
          {runs.data&&<nav className="observe-pagination" aria-label={t('runs')}><Button disabled={!cursor} onClick={()=>setCursor(undefined)}>{t('first')}</Button><Button disabled={!runs.data.nextCursor} onClick={()=>setCursor(runs.data!.nextCursor!)}>{t('next')}</Button></nav>}
          {selectedSession&&<MaintenanceView key={selectedSession} request={request} t={t} sessionId={selectedSession}/>}
        </div>}
      </>}
      </main>
    </div>
  </section>;
}
