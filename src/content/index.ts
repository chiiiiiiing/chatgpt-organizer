import { request } from '../shared/client';
import type { PageSnapshot, Snapshot } from '../shared/types';
import { observePage, readPage } from './adapter';
import { Organizer } from './organizer';
import { Timeline } from './timeline';
import utilityCSS from './utility.css?inline';

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
utilityStyle.textContent = utilityCSS;
const floating = document.createElement('button'); floating.className = 'launcher'; floating.type = 'button'; floating.hidden = true;
floating.innerHTML = '<svg class="folder-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/><path d="M3 10h18"/></svg><svg class="close-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg>';
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
let layoutFrame = 0;
let layoutTargets: HTMLElement[] = [];
const layoutObserver = new ResizeObserver(() => scheduleMount());
function scheduleMount() {
  if (stopped || layoutFrame) return;
  layoutFrame = requestAnimationFrame(() => { layoutFrame = 0; mount(); });
}
function observeLayout() {
  const targets = [...new Set([page.sidebarRegion, page.sidebar, page.readingRoot].filter((node): node is HTMLElement => !!node))];
  if (targets.length === layoutTargets.length && targets.every((node, i) => node === layoutTargets[i])) return;
  layoutObserver.disconnect(); layoutTargets = targets;
  for (const target of targets) layoutObserver.observe(target);
}
function onScreenRect(node: HTMLElement | null | undefined) {
  if (!node?.isConnected) return null;
  const rect = node.getBoundingClientRect(), style = getComputedStyle(node);
  return style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0 && rect.right > 0
    && rect.left < innerWidth && rect.bottom > 0 && rect.top < innerHeight ? rect : null;
}
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
  observeLayout();
  const sidebar = page.sidebar;
  const rect = onScreenRect(sidebar), region = onScreenRect(page.sidebarRegion);
  const inSidebar = rect && rect.width >= 130 && (!region || region.width >= 130);
  if (inSidebar && sidebar) {
    if (organizerHost.node.parentElement !== sidebar) sidebar.prepend(organizerHost.node);
    organizerHost.node.style.cssText = 'display:block;position:relative;width:calc(100% - 12px);max-width:100%;margin:8px 6px 12px;flex-shrink:0;';
    floating.hidden = true; floatingOpen = false;
  } else {
    if (organizerHost.node.parentElement !== document.body) document.body.append(organizerHost.node);
    // A collapsed native sidebar still contains clickable icons. Keep both the
    // launcher and its panel outside that rail, including during width changes.
    const mainLeft = onScreenRect(page.readingRoot)?.left ?? 0;
    const boundary = region?.right ?? (mainLeft > 0 && mainLeft < 130 ? mainLeft : 0);
    const left = Math.max(8, Math.min(Math.ceil(boundary) + 8, innerWidth - 48));
    const top = Math.min(76, Math.max(8, innerHeight - 230));
    const panelTop = top + 48, width = Math.max(0, Math.min(300, innerWidth - left - 8));
    const maxHeight = Math.max(0, innerHeight - panelTop - 150);
    floating.style.setProperty('--launcher-left', `${left}px`);
    floating.style.setProperty('--launcher-top', `${top}px`);
    organizerHost.node.style.cssText = `display:${floatingOpen ? 'block' : 'none'};position:fixed;left:${left}px;top:${panelTop}px;width:${width}px;max-height:${maxHeight}px;overflow:auto;z-index:10000;border-radius:14px;box-shadow:0 8px 36px #0002;`;
    floating.hidden = false;
  }
  floating.title = floatingOpen ? '关闭整理面板' : '打开整理面板';
  floating.setAttribute('aria-label', floating.title);
  floating.setAttribute('aria-expanded', String(floatingOpen));
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
  if (event.key === 'Escape' && floatingOpen && !organizerHost.shadow.querySelector('dialog[open]')) {
    floatingOpen = false; mount(); floating.focus();
  }
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
window.addEventListener('resize', scheduleMount, { passive: true, signal: events.signal });
connect(); void refresh();
world[singleton] = () => {
  stopped = true; stopObserver(); events.abort(); clearTimeout(noticeTimer); clearTimeout(reconnectTimer);
  layoutObserver.disconnect(); cancelAnimationFrame(layoutFrame);
  releaseInset();
  port?.disconnect(); organizer.destroy(); timeline.destroy();
  for (const item of [organizerHost, timelineHost, utilityHost]) item.node.remove();
};
