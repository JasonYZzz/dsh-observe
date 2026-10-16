import { useEffect, useRef, useState } from 'react';
import { Button, Input } from '@deepseek-ai/dsh-client-ui-primitives';
import type { LogPage } from '../types.js';
import type { Api } from './api.js';
import type { Text } from './locales.js';
import { useQuery } from './useQuery.js';
import { time } from './format.js';
const levels = { error: 'error', warn: 'logWarning', info: 'logInfo', debug: 'logDebug' } as const;
export function LogView({ request, t, sessionId, runId, nodeId }: { request: Api; t: Text; sessionId?: string; runId?: string; nodeId?: string }) {
  const formRef = useRef<HTMLFormElement>(null);
  const [filters, setFilters] = useState<Record<string, unknown>>({});
  const defaultScope = nodeId ? 'node' : runId ? 'run' : sessionId ? 'session' : 'all';
  const [scope, setScope] = useState(defaultScope);
  const [cursor, setCursor] = useState<string>();
  useEffect(() => { setScope(defaultScope); setFilters({}); setCursor(undefined); }, [nodeId, runId, sessionId]);
  const association = scope === 'node' && nodeId ? { nodeId } : scope === 'run' && runId ? { runId } : scope === 'session' && sessionId ? { sessionId } : scope === 'unassociated' ? { unassociated: true } : {};
  const result = useQuery<LogPage>(request, 'logs.list', { ...filters, ...association, limit: 50, cursor });
  const showUnassociated = ['session', 'run', 'node'].includes(scope) && Boolean(result.data?.unassociatedCount);
  return <section className="observe-logs"><h2>{t('operationalLogs')}</h2>
    <p className="observe-log-help">{t('logHelp')}</p>
    <details className="observe-log-rules"><summary>{t('logSearchDetails')}</summary><p>{t('logRules')}</p><p>{t('logMatchRules')}</p><p>{t('logAssociationRules')}</p></details>
    <form ref={formRef} key={`${sessionId}:${runId}:${nodeId}`} className="observe-filters" onReset={() => { setFilters({}); setCursor(undefined); }} onSubmit={(event) => {
      event.preventDefault(); const form = new FormData(event.currentTarget);
      setFilters(Object.fromEntries([...form.entries()].map(([key, value]) => [key, String(value).trim()]).filter(([, value]) => value !== '').map(([key, value]) => [key, key === 'from' || key === 'to' ? new Date(value).getTime() : value]))); setCursor(undefined);
    }}>
      <label>{t('scope')}<select aria-label={t('scope')} value={scope} onChange={(event) => { setScope(event.target.value); setCursor(undefined); }}>
        {sessionId && <option value="session">{t('sessionLogs')}</option>}{runId && <option value="run">{t('run')}</option>}{nodeId && <option value="node">{t('nodeScope')}</option>}
        <option value="all">{t('allOperationalLogs')}</option><option value="unassociated">{t('unassociatedLogs')}</option>
      </select></label>
      <label>{t('level')}<select aria-label={t('level')} name="level"><option value="">{t('all')}</option>{(['error', 'warn', 'info'] as const).map((value) => <option key={value} value={value}>{t(levels[value])}</option>)}</select></label>
      <label>{t('logger')}<Input name="source" maxLength={256} placeholder={t('logSourcePlaceholder')} /></label><label>{t('from')}<Input name="from" type="datetime-local" /></label><label>{t('to')}<Input name="to" type="datetime-local" /></label>
      <label>{t('logKeyword')}<Input name="text" maxLength={200} placeholder={t('logKeywordPlaceholder')} /></label><div className="observe-log-actions"><Button type="submit" variant="outline">{t('searchLogs')}</Button><Button type="reset">{t('reset')}</Button></div>
    </form>
    {result.error && <p role="alert">{result.error} <Button onClick={result.refresh}>{t('retry')}</Button></p>}
    {!result.data && !result.error && <p role="status">{t('loading')}</p>}
    {result.data && <><div className="observe-log-count" role="status"><span>{t('logScopeCount', { count: result.data.scopeCount.toLocaleString() })}</span>{showUnassociated && <><span>{t('unassociatedLogCount', { count: result.data.unassociatedCount.toLocaleString() })}</span><Button onClick={() => { formRef.current?.reset(); setScope('unassociated'); setCursor(undefined); }}>{t('showUnassociatedLogs')}</Button></>}</div>
      {!result.data.items.length ? <p>{t(result.data.scopeCount ? 'noLogMatches' : 'noCapturedLogs')}</p> : <div className="observe-table-wrap"><table><thead><tr><th>{t('logTime')}</th><th>{t('level')}</th><th>{t('logger')}</th><th>{t('logText')}</th></tr></thead><tbody>{result.data.items.map((log) => <tr key={log.id}><td>{time(log.time)}</td><td>{log.level in levels ? t(levels[log.level as keyof typeof levels]) : log.level}</td><td>{log.source}<small>{!log.sessionId ? t('unassociatedLogs') : !log.runId ? t('unassigned') : ''}</small></td><td><pre>{log.summary}</pre></td></tr>)}</tbody></table></div>}
      <nav className="observe-pagination" aria-label={t('logs')}><Button disabled={!cursor} onClick={() => setCursor(undefined)}>{t('first')}</Button><Button disabled={!result.data.nextCursor} onClick={() => setCursor(result.data!.nextCursor!)}>{t('next')}</Button></nav>
    </>}
  </section>;
}
