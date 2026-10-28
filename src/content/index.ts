import { request } from '../shared/client';
import type { PageSnapshot, Snapshot } from '../shared/types';
import { observePage, readPage } from './adapter';
import { Organizer } from './organizer';
import { Timeline } from './timeline';

const singleton = '__chatgptOrganizerCleanup';
const world = globalThis as typeof globalThis & { [singleton]?: () => void };
world[singleton]?.();

function host(name: string) {
  const node = document.createElement('div'); node.dataset.cgoRoot = name;
  return { node, shadow: node.attachShadow({ mode: 'open' }) };
}
const organizerHost = host('organizer'), timelineHost = host('timeline'), utilityHost = host('utility');
document.body.append(organizerHost.node, timelineHost.node, utilityHost.node);
const utilityStyle = document.createElement('style');
utilityStyle.textContent = `:host{all:initial;--utility-bg:var(--bg-primary,var(--main-surface-primary,#fff));--utility-ink:var(--text-primary,#171717);--utility-line:var(--border-light,rgb(0 0 0 / 10%));font:12px/1.6 -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif}[hidden]{display:none!important}button{font:inherit;cursor:pointer;position:fixed;left:14px;top:76px;z-index:10001;background:var(--utility-bg);color:var(--utility-ink);border:1px solid var(--utility-line);border-radius:10px;padding:8px 12px;box-shadow:0 2px 14px #00000012}button:focus-visible{outline:2px solid var(--utility-ink);outline-offset:3px}.toast{position:fixed;left:50%;transform:translateX(-50%);bottom:130px;z-index:2147483646;padding:12px 20px;border-radius:12px;background:var(--utility-ink);color:var(--utility-bg);box-shadow:0 4px 30px #0002;max-width:min(580px,85vw);text-align:center;font-size:12px;line-height:1.7}:host([data-theme=dark]){--utility-bg:var(--bg-primary,var(--main-surface-primary,#212121));--utility-ink:var(--text-primary,#ececec);--utility-line:var(--border-light,rgb(255 255 255 / 12%))}`;
const floating = document.createElement('button'); floating.textContent = '▱ 整理'; floating.setAttribute('aria-label', '打开整理面板'); floating.hidden = true;
const notice = document.createElement('div'); notice.className = 'toast'; notice.setAttribute('role', 'status'); notice.hidden = true;
utilityHost.shadow.append(utilityStyle, floating, notice);
let noticeTimer: ReturnType<typeof setTimeout>;
function notify(message: string) {
  notice.textContent = message; notice.hidden = false;
  clearTimeout(noticeTimer); noticeTimer = setTimeout(() => { notice.hidden = true; }, 6000);
}
const organizer = new Organizer(organizerHost.shadow, request, notify);
const timeline = new Timeline(timelineHost.shadow, request, notify);
let page: PageSnapshot = readPage(), state: Snapshot | null = null, floatingOpen = false, stopped = false;
const discovered = new Map<string, string>();
let refreshRunning = false, refreshAgain = false;
let port: chrome.runtime.Port | null = null, reconnectTimer: ReturnType<typeof setTimeout>;
const events = new AbortController();
let insetRoot: HTMLElement | null = null;
let originalPadding = '', originalPriority = '', appliedPadding = '';
function releaseInset() {
  if (insetRoot?.style.getPropertyValue('padding-inline-end') === appliedPadding) {
    if (originalPadding) insetRoot.style.setProperty('padding-inline-end', originalPadding, originalPriority);
    else insetRoot.style.removeProperty('padding-inline-end');
  }
  insetRoot = null;
}
function updateInset() {
  const target = state?.settings.timelineExpanded && !state.settings.timelineHidden && innerWidth >= 1280 ? page.readingRoot : null;
  if (target !== insetRoot) {
    releaseInset();
    if (target) {
      insetRoot = target;
      originalPadding = target.style.getPropertyValue('padding-inline-end');
      originalPriority = target.style.getPropertyPriority('padding-inline-end');
      const existing = parseFloat(getComputedStyle(target).paddingInlineEnd) || 0;
      appliedPadding = `${Math.max(existing, 334)}px`;
    }
  }
  if (insetRoot && insetRoot.style.getPropertyValue('padding-inline-end') !== appliedPadding) {
    insetRoot.style.setProperty('padding-inline-end', appliedPadding, 'important');
  }
}

function mount() {
  if (stopped) return;
  const sidebar = page.sidebar;
  const rect = sidebar?.getBoundingClientRect();
  const inSidebar = sidebar?.isConnected && rect && rect.width >= 130 && rect.right > 0
    && rect.left < innerWidth && rect.bottom > 0 && rect.top < innerHeight;
  if (inSidebar) {
    if (organizerHost.node.parentElement !== sidebar) sidebar.prepend(organizerHost.node);
    organizerHost.node.style.cssText = 'display:block;position:relative;width:calc(100% - 12px);max-width:100%;margin:8px 6px 12px;flex-shrink:0;';
    floating.hidden = true; floatingOpen = false;
  } else {
    if (organizerHost.node.parentElement !== document.body) document.body.append(organizerHost.node);
    organizerHost.node.style.cssText = `display:${floatingOpen ? 'block' : 'none'};position:fixed;left:14px;top:120px;width:min(300px,calc(100vw - 72px));max-height:calc(100vh - 270px);overflow:auto;z-index:10000;border-radius:14px;box-shadow:0 8px 36px #0002;`;
    floating.hidden = false; floating.textContent = floatingOpen ? '× 收起整理' : '▱ 整理';
    floating.setAttribute('aria-label', floatingOpen ? '关闭整理面板' : '打开整理面板');
  }
  for (const item of [timelineHost, utilityHost]) if (!item.node.isConnected) document.body.append(item.node);
  for (const item of [organizerHost, timelineHost, utilityHost]) item.node.dataset.theme = page.dark ? 'dark' : 'light';
  updateInset();
}
function render() {
  mount();
  if (!state) return;
  organizer.update(state, page); timeline.update(page, state.settings);
}
floating.onclick = () => { floatingOpen = !floatingOpen; mount(); };
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && floatingOpen) { floatingOpen = false; mount(); }
}, { signal: events.signal });

async function refresh() {
  if (stopped) return;
  if (refreshRunning) { refreshAgain = true; return; }
  refreshRunning = true;
  try { state = await request({ type: 'getState' }); if (!stopped) render(); }
  catch (error) { if (!stopped) notify(`整理空间：${error instanceof Error ? error.message : String(error)} 刷新页面可重新连接。`); }
  finally { refreshRunning = false; if (refreshAgain) { refreshAgain = false; void refresh(); } }
}
async function discoverPage(next: PageSnapshot) {
  const changed = next.conversations.filter(ref => discovered.get(ref.id) !== `${ref.title}\0${ref.url}`);
  if (!changed.length) return;
  for (const ref of changed) discovered.set(ref.id, `${ref.title}\0${ref.url}`);
  try {
    await request({ type: 'discover', conversations: changed });
    if (!stopped) void refresh();
  } catch {
    for (const ref of changed) discovered.delete(ref.id);
  }
}
const stopObserver = observePage(next => {
  if (stopped) return;
  page = next; render(); void discoverPage(next);
});

function connect() {
  if (stopped || !chrome.runtime?.id) return;
  try {
    port = chrome.runtime.connect({ name: 'content' });
    port.onMessage.addListener(message => { if (message?.type === 'changed') void refresh(); });
    port.onDisconnect.addListener(() => {
      void chrome.runtime.lastError; port = null;
      if (!stopped && chrome.runtime?.id) reconnectTimer = setTimeout(() => { connect(); void refresh(); }, 2000);
    });
  } catch { /* Extension reload invalidates old content scripts; a page refresh reconnects. */ }
}
window.addEventListener('focus', () => void refresh(), { signal: events.signal });
window.addEventListener('resize', mount, { passive: true, signal: events.signal });
connect(); void refresh();
world[singleton] = () => {
  stopped = true; stopObserver(); events.abort(); clearTimeout(noticeTimer); clearTimeout(reconnectTimer);
  releaseInset();
  port?.disconnect(); organizer.destroy(); timeline.destroy();
  for (const item of [organizerHost, timelineHost, utilityHost]) item.node.remove();
};
