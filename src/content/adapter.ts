import type { ConversationRef, PageSnapshot, Turn } from '../shared/types';

/** All ChatGPT-specific selectors live here. The adapter only reads rendered UI. */
const SELECTORS = {
  ownRoot: '[data-cgo-root]',
  main: 'main, [role="main"]',
  messages: '[data-message-author-role="user"], [data-message-author-role="assistant"], article[data-turn="user"], article[data-turn="assistant"], [data-testid="user-message"], [data-testid="assistant-message"]',
  author: '[data-message-author-role="user"], [data-message-author-role="assistant"]',
  sidebar: '#stage-slideover-sidebar, [data-testid="left-sidebar"], [data-testid="sidebar"], nav[aria-label="Chat history"], nav[aria-label="聊天记录"], nav[aria-label="聊天历史"], aside, nav',
  history: '#history, [data-testid="history"], [data-testid="chat-history"]',
  chatLink: 'a[href*="/c/"]',
  messageId: '[data-message-id]',
  skipText: 'button, [role="button"], svg, script, style, textarea, input, select, [aria-hidden="true"], [hidden], .sr-only, [data-cgo-root]',
  blocks: 'p, div, li, pre, h1, h2, h3, h4, h5, h6, blockquote, tr',
} as const;

interface JumpIdentity { conversationId: string | null; node: HTMLElement; messageId: string | null }
const jumpIdentities = new WeakMap<Turn, JumpIdentity>();
type Role = 'user' | 'assistant';

function ownNode(node: Node | null): boolean {
  if (!node) return false;
  const element = node instanceof Element ? node : node.parentElement;
  if (element?.closest(SELECTORS.ownRoot)) return true;
  const root = node.getRootNode();
  return root instanceof ShadowRoot && !!root.host.closest(SELECTORS.ownRoot);
}

function visible(element: Element): boolean {
  if (!element.isConnected || ownNode(element)) return false;
  for (let current: Element | null = element; current; current = current.parentElement) {
    if (current.hasAttribute('hidden') || current.getAttribute('aria-hidden') === 'true') return false;
    const style = getComputedStyle(current);
    if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') return false;
  }
  return true;
}

/** Strip controls and accessibility labels; no message HTML is persisted or executed. */
function readableText(element: Element): string {
  const clone = element.cloneNode(true) as Element;
  clone.querySelectorAll(SELECTORS.skipText).forEach((node) => node.remove());
  clone.querySelectorAll('br').forEach((node) => node.replaceWith(document.createTextNode('\n')));
  clone.querySelectorAll(SELECTORS.blocks).forEach((node) => node.append(document.createTextNode('\n')));
  return (clone.textContent ?? '')
    .replace(/\u00a0/g, ' ')
    .replace(/[\t ]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function conversationFromUrl(value: string): { id: string; url: string } | null {
  try {
    const url = new URL(value, 'https://chatgpt.com');
    if (url.origin !== 'https://chatgpt.com' || url.username || url.password) return null;
    const match = url.pathname.match(/^\/(?:g\/[^/]+\/)?c\/([A-Za-z0-9_-]{1,128})\/?$/);
    if (!match || ['__proto__', 'constructor', 'prototype'].includes(match[1])) return null;
    return { id: match[1], url: `${url.origin}${url.pathname.replace(/\/$/, '')}` };
  } catch { return null; }
}

function shortTitle(value: string): string { return value.replace(/\s+/g, ' ').trim().slice(0, 512); }

function sidebarOnScreen(node: HTMLElement): boolean {
  if (!visible(node)) return false;
  const rect = node.getBoundingClientRect();
  // A transform-hidden native sidebar still has width and visible computed
  // styles. Only apply geometry checks when layout is available (not jsdom).
  return (!rect.width && !rect.height) || (rect.right > 0 && rect.left < innerWidth && rect.bottom > 0 && rect.top < innerHeight);
}

function sidebarRegion(): { region: HTMLElement | null; mount: HTMLElement | null } {
  const candidates = Array.from(document.querySelectorAll<HTMLElement>(SELECTORS.sidebar))
    .filter(sidebarOnScreen);
  // Prefer the outer, explicitly identified sidebar over nested nav elements.
  const region = candidates.find((node) => node.matches('#stage-slideover-sidebar, [data-testid="left-sidebar"], [data-testid="sidebar"]'))
    ?? candidates.find((node) => Array.from(node.querySelectorAll<HTMLAnchorElement>(SELECTORS.chatLink)).some((link) => !ownNode(link) && conversationFromUrl(link.href)))
    ?? candidates.find((node) => /history|聊天|历史/i.test(node.getAttribute('aria-label') ?? ''))
    ?? null;
  if (!region) return { region: null, mount: null };
  const explicit = region.matches(SELECTORS.history) ? region : region.querySelector<HTMLElement>(SELECTORS.history);
  if (explicit && visible(explicit)) return { region, mount: explicit };
  const first = Array.from(region.querySelectorAll<HTMLAnchorElement>(SELECTORS.chatLink))
    .find((link) => !ownNode(link) && conversationFromUrl(link.href));
  if (!first) return { region, mount: region };
  const group = first.closest<HTMLElement>('section, ol, ul, [role="list"]');
  if (group && region.contains(group)) {
    const mount = group.matches('ol, ul, [role="list"]') ? group.parentElement : group;
    if (mount && region.contains(mount)) return { region, mount };
  }
  let mount: HTMLElement = first.parentElement ?? region;
  while (mount.parentElement && mount.parentElement !== region && region.contains(mount.parentElement)) mount = mount.parentElement;
  return { region, mount };
}

function roleOf(node: Element): Role | null {
  const declared = node.getAttribute('data-message-author-role') ?? node.getAttribute('data-turn');
  if (declared === 'user' || declared === 'assistant') return declared;
  const testId = node.getAttribute('data-testid');
  if (testId === 'user-message') return 'user';
  if (testId === 'assistant-message') return 'assistant';
  return null;
}

function messageId(node: HTMLElement): string | null {
  return node.getAttribute('data-message-id')
    ?? node.closest<HTMLElement>('[data-message-id]')?.getAttribute('data-message-id')
    ?? node.querySelector(SELECTORS.messageId)?.getAttribute('data-message-id')
    ?? null;
}

function fingerprint(text: string): string {
  let hash = 2166136261;
  for (let index = 0; index < text.length; index++) hash = Math.imul(hash ^ text.charCodeAt(index), 16777619);
  return (hash >>> 0).toString(36);
}

function readTurns(main: HTMLElement | null, conversationId: string | null): Turn[] {
  if (!main) return [];
  const candidates = Array.from(main.querySelectorAll<HTMLElement>(SELECTORS.messages)).filter(visible);
  // Articles and message bodies can both declare a role. Keep only the innermost
  // declaration so a rendered message is never counted twice.
  const candidateSet = new Set(candidates);
  const redundant = new Set<HTMLElement>();
  for (const node of candidates) {
    for (let ancestor = node.parentElement; ancestor && ancestor !== main; ancestor = ancestor.parentElement) {
      if (candidateSet.has(ancestor)) redundant.add(ancestor);
    }
  }
  const nodes = candidates.filter((node) => !redundant.has(node));
  const occurrences = new Map<string, number>();
  const turns: Turn[] = [];
  for (const node of nodes) {
    const role = roleOf(node);
    const text = readableText(node);
    if (role === 'user') {
      const id = messageId(node);
      const signature = id ? `id:${id}` : `text:${fingerprint(text)}`;
      const occurrence = (occurrences.get(signature) ?? 0) + 1;
      occurrences.set(signature, occurrence);
      const article = node.closest<HTMLElement>('article');
      const element = article && main.contains(article) ? article : node;
      const turn: Turn = {
        key: `${conversationId ?? 'draft'}:${signature}:${occurrence}`,
        index: turns.length,
        question: text || '（图片或附件消息）',
        answer: '', element, messageId: id,
      };
      jumpIdentities.set(turn, { conversationId, node, messageId: id });
      turns.push(turn);
    } else if (role === 'assistant' && turns.length) {
      const turn = turns[turns.length - 1];
      turn.answer = [turn.answer, text].filter(Boolean).join('\n\n');
    }
  }
  return turns;
}

function scrollContainer(main: HTMLElement | null, firstTurn?: Turn): HTMLElement | null {
  for (let node: HTMLElement | null = firstTurn?.element.parentElement ?? main; node; node = node.parentElement) {
    const overflow = getComputedStyle(node).overflowY;
    if (/(auto|scroll|overlay)/.test(overflow) && node.scrollHeight > node.clientHeight) return node;
  }
  return (document.scrollingElement as HTMLElement | null) ?? document.documentElement;
}

function pageTitle(): string {
  const title = document.title.replace(/\s*[-–—|]\s*ChatGPT\s*$/i, '').replace(/^ChatGPT\s*[-–—|]\s*/i, '').trim();
  return /^ChatGPT$/i.test(title) ? '' : shortTitle(title);
}

export function readPage(): PageSnapshot {
  const current = conversationFromUrl(location.href);
  const main = Array.from(document.querySelectorAll<HTMLElement>(SELECTORS.main)).find(visible) ?? null;
  const turns = readTurns(main, current?.id ?? null);
  const { region, mount } = sidebarRegion();
  const conversations = new Map<string, ConversationRef>();
  const seenAt = Date.now();
  if (region) for (const link of region.querySelectorAll<HTMLAnchorElement>(SELECTORS.chatLink)) {
    if (ownNode(link) || !visible(link)) continue;
    const parsed = conversationFromUrl(link.href);
    if (!parsed) continue;
    const title = shortTitle(link.getAttribute('title') || readableText(link)) || '未命名对话';
    conversations.set(parsed.id, { ...parsed, title, seenAt });
  }
  const title = (current ? conversations.get(current.id)?.title : null)
    || pageTitle()
    || shortTitle(turns[0]?.question ?? '')
    || '未命名对话';
  if (current) conversations.set(current.id, { ...current, title, seenAt });
  const root = document.documentElement;
  const dark = root.classList.contains('dark') || root.dataset.theme === 'dark'
    || root.getAttribute('data-color-mode') === 'dark'
    || (!root.classList.contains('light') && !root.dataset.theme && root.style.colorScheme === 'dark');
  return {
    conversationId: current?.id ?? null, title, turns,
    conversations: Array.from(conversations.values()), sidebar: mount, readingRoot: main,
    scrollContainer: scrollContainer(main, turns[0]), dark,
  };
}

function meaningfulMutation(mutation: MutationRecord): boolean {
  if (ownNode(mutation.target)) return false;
  if (mutation.type !== 'childList') return true;
  const nodes = [...mutation.addedNodes, ...mutation.removedNodes];
  return nodes.some((node) => !ownNode(node) && !(node.nodeType === Node.TEXT_NODE && !node.textContent?.trim()));
}

function sameQuestions(left: PageSnapshot, right: PageSnapshot): boolean {
  return left.turns.length === right.turns.length && left.turns.every((turn, index) => {
    const other = right.turns[index];
    return turn.element === other.element && turn.messageId === other.messageId
      && turn.question === other.question;
  });
}

/** Route polling fills the isolated-world pushState gap; no page script injection. */
export function observePage(callback: (page: PageSnapshot) => void): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let lastHref = location.href;
  let lastPage = readPage();
  let pendingOldPage: PageSnapshot | null = null;
  callback(lastPage);
  const update = () => {
    timer = undefined;
    if (stopped) return;
    const page = readPage();
    if (page.conversationId !== lastPage.conversationId) {
      pendingOldPage = lastPage.conversationId && lastPage.turns.length ? lastPage : null;
    }
    lastHref = location.href;
    // A response from the old chat may keep streaming during navigation. Only
    // question identity / nodes can release this guard, not assistant text.
    if (pendingOldPage && page.turns.length && sameQuestions(pendingOldPage, page)) {
      lastPage = { ...page, title: '正在加载对话…', turns: [], conversations: page.conversations.filter((item) => item.id !== page.conversationId) };
    } else {
      pendingOldPage = null;
      lastPage = page;
    }
    callback(lastPage);
  };
  // A bounded debounce keeps a long streaming response updating continuously.
  const schedule = () => { if (!stopped && timer === undefined) timer = setTimeout(update, 100); };
  const observer = new MutationObserver((mutations) => { if (mutations.some(meaningfulMutation)) schedule(); });
  observer.observe(document.documentElement, {
    subtree: true, childList: true, characterData: true, attributes: true,
    attributeFilter: ['data-message-id', 'data-message-author-role', 'data-turn', 'data-theme', 'data-color-mode', 'aria-hidden', 'hidden', 'class', 'style', 'href', 'title'],
  });
  window.addEventListener('popstate', schedule);
  window.addEventListener('resize', schedule, { passive: true });
  document.addEventListener('visibilitychange', schedule);
  const interval = setInterval(() => { if (location.href !== lastHref) schedule(); }, 700);
  return () => {
    stopped = true;
    observer.disconnect();
    if (timer !== undefined) clearTimeout(timer);
    clearInterval(interval);
    window.removeEventListener('popstate', schedule);
    window.removeEventListener('resize', schedule);
    document.removeEventListener('visibilitychange', schedule);
  };
}

/** Returns false when a stale node no longer represents this exact question. */
export function jumpToTurn(turn: Turn): boolean {
  const identity = jumpIdentities.get(turn);
  if (!identity || !turn.element.isConnected || !identity.node.isConnected || !visible(identity.node)) return false;
  if ((conversationFromUrl(location.href)?.id ?? null) !== identity.conversationId) return false;
  if (messageId(identity.node) !== identity.messageId) return false;
  if ((readableText(identity.node) || '（图片或附件消息）') !== turn.question) return false;
  const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  if (typeof turn.element.scrollIntoView !== 'function') return false;
  turn.element.scrollIntoView({ behavior: reducedMotion ? 'instant' : 'smooth', block: 'center' });
  if (typeof turn.element.animate === 'function') {
    turn.element.animate([
      { outline: '2px solid rgba(16,163,127,0.8)', outlineOffset: '6px', borderRadius: '10px' },
      { outline: '2px solid rgba(16,163,127,0)', outlineOffset: '6px', borderRadius: '10px' },
    ], { duration: reducedMotion ? 300 : 1800, easing: 'ease-out' });
  }
  return true;
}
