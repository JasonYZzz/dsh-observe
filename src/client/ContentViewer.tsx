import { useState } from 'react';
import { Button } from '@deepseek-ai/dsh-client-ui-primitives';
import type { ContentCategory, ContentRef } from '../inspection.js';
import type { Api } from './api.js';
import type { Text } from './locales.js';
import { useQuery } from './useQuery.js';
export const categoryLabels = { system: 'roleSystem', user: 'roleUser', context: 'roleContext', assistant: 'roleAssistant', tool: 'roleTool', event: 'roleEvent' } as const satisfies Record<ContentCategory, keyof typeof import('./locales.js').zh>;
const sourceLabels: Record<string, keyof typeof import('./locales.js').zh> = {
  'user-approval': 'sourceApproval', 'runtime-context': 'sourceRuntime', 'agent-instructions': 'sourceInstructions',
  'skill-invocation': 'sourceSkill', 'skill-catalog': 'sourceCatalog', 'skills': 'sourceCatalog', 'session-reference': 'sourceReference',
  'compact-checkpoint': 'sourceCheckpoint', 'system-reminder': 'sourceReminder', 'system-prompt': 'sourcePrompt',
  model: 'sourceModel', user: 'sourceUser', tool: 'sourceTool',
};
const formLabels: Record<string, keyof typeof import('./locales.js').zh> = { instructions: 'formInstructions', catalog: 'formCatalog', snapshot: 'formSnapshot', notice: 'formNotice', relay: 'formRelay', recall: 'formRecall' };
interface ContentPage { text: string; offset: number; total: number; nextOffset: number | null; truncated: boolean }
function readable(text: string) {
  try { const value = JSON.parse(text); if (Array.isArray(value)) return value.map((block) => block.text ?? (block.type === 'tool-call' ? `${block.name}\n${typeof block.arguments === 'string' ? block.arguments : JSON.stringify(block.arguments, null, 2)}` : JSON.stringify(block, null, 2))).join('\n\n'); } catch {}
  return text;
}
export function ContentViewer({ request, t, sessionId, item }: { request: Api; t: Text; sessionId: string; item: ContentRef }) {
  const [offset, setOffset] = useState(0); const [raw, setRaw] = useState(false); const [copied, setCopied] = useState(false);
  const result = useQuery<ContentPage>(request, 'content.get', { sessionId, seq: item.seq, part: item.part, index: item.index, offset, limit: 16384 }, true, undefined, false);
  if (result.error) return <p role="alert">{result.error} <Button onClick={result.refresh}>{t('retry')}</Button></p>;
  if (!result.data) return <p role="status">{t('loading')}</p>;
  const value = result.data; const text = raw || offset || value.nextOffset !== null ? value.text : readable(value.text);
  return <div className="observe-content"><div className="observe-content-toolbar"><span>seq {item.seq} · {value.total.toLocaleString()} {t('characters')}</span><div>
    {item.part === 'message' && <Button aria-pressed={raw} onClick={() => setRaw(!raw)}>{raw ? t('readable') : 'JSON'}</Button>}
    <Button onClick={async () => { try { await navigator.clipboard.writeText(text); setCopied(true); } catch { setCopied(false); } }}>{copied ? t('copied') : t('copyPage')}</Button></div></div>
    <pre className={item.part === 'message' && !raw ? 'observe-readable' : undefined} tabIndex={0} aria-label={`${t('content')} · ${t(categoryLabels[item.category])}`}>{text || t('emptyContent')}</pre>
    {value.truncated && <p role="status">{t('displayLimit')}</p>}
    {(offset > 0 || value.nextOffset !== null) && <nav className="observe-pagination" aria-label={t('content')}><span>{offset + 1}–{Math.min(offset + value.text.length, value.total)} / {value.total}</span><Button disabled={!offset} onClick={() => {setOffset(Math.max(0, offset - 16384));setCopied(false);}}>{t('previous')}</Button><Button disabled={value.nextOffset === null} onClick={() => {setOffset(value.nextOffset!);setCopied(false);}}>{t('next')}</Button></nav>}
  </div>;
}
export function ContentItem({ request, t, sessionId, item, expanded = false }: { request: Api; t: Text; sessionId: string; item: ContentRef; expanded?: boolean }) {
  const [open, setOpen] = useState(expanded);
  const label = item.part === 'tool' || item.part === 'arguments' ? item.label : ['user', 'model', 'tool'].includes(item.sourceKind ?? '') ? t(categoryLabels[item.category]) : sourceLabels[item.sourceKind ?? ''] ? t(sourceLabels[item.sourceKind!]) : item.category === 'context' ? t('sourceInjected') : t(categoryLabels[item.category]);
  return <details data-category={item.category} className="observe-content-item" open={open} onToggle={(event) => setOpen(event.currentTarget.open)}><summary><span className="observe-role" data-category={item.category}>{t(categoryLabels[item.category])}</span>{label !== t(categoryLabels[item.category]) && <strong>{label}</strong>}{item.form && formLabels[item.form] && <span className="observe-form">{t(formLabels[item.form])}</span>}<span className="observe-item-preview">{item.preview}</span><small>#{item.seq}</small></summary>
    {open && <><ContentViewer request={request} t={t} sessionId={sessionId} item={item} /><details className="observe-message-source"><summary>{t('messageSource')}</summary><dl><dt>{t('protocolRole')}</dt><dd>{item.role}</dd><dt>{t('sourceKind')}</dt><dd>{item.sourceKind ?? t('missing')}</dd>{item.form && <><dt>{t('contextForm')}</dt><dd>{item.form}</dd></>}</dl></details></>}
  </details>;
}
