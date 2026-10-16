import type { Context } from '@deepseek-ai/cordis';
import type { ClientConnectionRpc } from '@deepseek-ai/dsh-client-connection/client';
import type {} from '@deepseek-ai/dsh-client-locale/client';
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client';
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client';
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client';
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client';
import { ObservePage } from './ObservePage.js';
import { api } from './api.js';
import { zh, en } from './locales.js';
import css from './style.css';

const NS = 'dsh-observe';
declare module '@deepseek-ai/dsh-client-ui-slots' { interface LocaleNamespaceMap { 'dsh-observe': keyof typeof zh } }
export const inject = ['slots', 'locale', 'connection', 'layout'];
export function apply(ctx: Context) {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-observe: locale');
  ctx.effect(() => {
    const style = document.createElement('style');
    style.dataset.plugin = NS;
    style.textContent = css;
    document.head.append(style);
    return () => style.remove();
  }, 'dsh-observe: styles');
  // Host and browser declare distinct Connection faces on the shared Cordis type.
  const request = api((ctx.connection as unknown as { rpc: ClientConnectionRpc }).rpc);
  const t = ctx.locale.bind(NS);
  ctx.on('connection/reset', () => window.dispatchEvent(new Event('dsh-observe-reconnect')));
  ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: NS, locale: NS, inject: () => ({ request, openGlobal: () => ctx.layout.selectPanel(NS as MainPanelId) }) }, ObservePage));
  ctx.slots.inject('conversation.view', () => ctx.slots.register({ name: 'conversation.view', id: NS, order: 20, locale: NS,
    label: () => t('title'), inject: (sessionId) => ({ request, sessionId, openGlobal: () => ctx.layout.selectPanel(NS as MainPanelId) }) }, ObservePage));
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({ name: 'sidebar.panellist', id: NS, order: 30, locale: NS,
    label: () => t('title') }, ({ size }: { size: number }) => <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><path d="M3 17h4l3-10 4 14 3-10h4" /></svg>));
  if (new URL(location.href).searchParams.has('observeRun') || new URL(location.href).searchParams.has('observeSession')) ctx.layout.selectPanel(NS as MainPanelId);
}
