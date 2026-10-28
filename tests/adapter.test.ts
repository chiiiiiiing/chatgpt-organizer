// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://chatgpt.com/"}
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { conversationFromUrl, jumpToTurn, observePage, readPage } from '../src/content/adapter';

const message = (role: string, text: string, id = '', extra = '') => `<article data-turn="${role}" ${extra}><div data-message-author-role="${role}" ${id ? `data-message-id="${id}"` : ''}><p>${text}</p><button>复制</button></div></article>`;
function fixture(content: string) {
  document.body.innerHTML = `<aside data-testid="left-sidebar"><nav><a href="/">新聊天</a><section id="history"><h2>聊天</h2><a href="/c/abc" title="原始标题">原始标题<button>菜单</button></a><a href="/g/g-special/c/def?x=1#anchor">另一段对话</a></section></nav></aside><main>${content}</main>`;
}

beforeEach(() => {
  vi.useFakeTimers();
  history.replaceState({}, '', '/c/abc');
  document.title = '测试聊天 - ChatGPT';
  document.documentElement.className = '';
  fixture('');
});
afterEach(() => { vi.useRealTimers(); document.body.innerHTML = ''; });

describe('conversation URLs', () => {
  it('accepts normal and GPT/project conversations and removes query/hash', () => {
    expect(conversationFromUrl('/c/abc/?search=1#q')).toEqual({ id: 'abc', url: 'https://chatgpt.com/c/abc' });
    expect(conversationFromUrl('https://chatgpt.com/g/g-project/c/chat_123')).toEqual({ id: 'chat_123', url: 'https://chatgpt.com/g/g-project/c/chat_123' });
  });
  it('rejects other hosts, dangerous identifiers and non-conversation routes', () => {
    for (const url of ['https://evil.example/c/abc', 'https://chatgpt.com.evil.example/c/abc', '/share/abc', '/', '/c/__proto__', '/c/abc/extra', 'javascript:alert(1)']) expect(conversationFromUrl(url)).toBeNull();
  });
});

describe('rendered conversation adapter', () => {
  it('groups successive assistant blocks into the preceding question and strips controls', () => {
    fixture(message('assistant', '上文残片', 'a0') + message('user', '第一个问题', 'u1') + message('assistant', '分析段落', 'a1') + message('assistant', '最终回答', 'a2') + message('user', '第二个问题', 'u2'));
    const page = readPage();
    expect(page.turns.map(({ question, answer, index }) => ({ question, answer, index }))).toEqual([
      { question: '第一个问题', answer: '分析段落\n\n最终回答', index: 0 },
      { question: '第二个问题', answer: '', index: 1 },
    ]);
    expect(page.sidebar?.id).toBe('history');
    expect(page.readingRoot).toBe(document.querySelector('main'));
    expect(page.title).toBe('原始标题');
    expect(page.conversations.map((item) => item.id)).toEqual(['abc', 'def']);
  });
  it('ignores hidden branches and the extension own content, while keeping repeated questions distinct', () => {
    fixture(message('user', '重复问题') + message('assistant', '可见回答') + message('user', '重复问题') + message('user', '旧分支', 'old', 'hidden') + `<div data-cgo-root>${message('user', '插件预览')}</div>`);
    document.querySelector('#history')!.insertAdjacentHTML('beforeend', '<div data-cgo-root><a href="/c/private">插件缓存</a></div>');
    const page = readPage();
    expect(page.turns).toHaveLength(2);
    expect(page.turns[0].key).not.toBe(page.turns[1].key);
    expect(page.conversations.some((item) => item.id === 'private')).toBe(false);
  });
  it('rebuilds only mounted current-branch turns after editing or virtual unmounting', () => {
    fixture(message('user', '问题一', 'u1') + message('assistant', '回答一', 'a1') + message('user', '问题二', 'u2'));
    const initial = readPage();
    document.querySelector('[data-message-id="u1"] p')!.textContent = '问题一编辑后';
    document.querySelector('[data-message-id="u2"]')!.closest('article')!.remove();
    const next = readPage();
    expect(next.turns).toHaveLength(1);
    expect(next.turns[0].question).toBe('问题一编辑后');
    expect(jumpToTurn(initial.turns[0])).toBe(false);
    expect(jumpToTurn(initial.turns[1])).toBe(false);
  });
  it('does not index an unsaved new conversation', () => {
    history.replaceState({}, '', '/');
    fixture(message('user', '尚未发送完成'));
    const page = readPage();
    expect(page.conversationId).toBeNull();
    expect(page.conversations).toHaveLength(2);
  });
  it('reads visible role declarations on articles when inner author nodes are absent', () => {
    fixture('<article data-turn="user"><h5 class="sr-only">You said:</h5><p>你好</p></article><article data-turn="assistant"><p>你好！</p></article>');
    expect(readPage().turns[0]).toMatchObject({ question: '你好', answer: '你好！' });
  });
  it('finds the actual scrollable ancestor and current theme', () => {
    fixture(`<div id="scroll" style="overflow-y:auto">${message('user', '滚动目标', 'u')}</div>`);
    const scroll = document.querySelector<HTMLElement>('#scroll')!;
    Object.defineProperties(scroll, { scrollHeight: { value: 1200 }, clientHeight: { value: 600 } });
    document.documentElement.classList.add('dark');
    const page = readPage();
    expect(page.scrollContainer).toBe(scroll);
    expect(page.dark).toBe(true);
  });
  it('does not mount in a native sidebar translated outside the viewport', () => {
    fixture(message('user', '侧栏收起', 'u1'));
    for (const node of document.querySelectorAll<HTMLElement>('aside, nav')) {
      node.getBoundingClientRect = () => ({ x: -260, y: 0, width: 260, height: 700, top: 0, bottom: 700, left: -260, right: 0, toJSON: () => ({}) });
    }
    expect(readPage().sidebar).toBeNull();
  });
});

describe('safe navigation', () => {
  it('scrolls to the selected repeated question, and refuses stale cross-chat targets', () => {
    fixture(message('user', '相同问题', 'u1') + message('user', '相同问题', 'u2'));
    const page = readPage();
    const scroll = vi.fn();
    page.turns[1].element.scrollIntoView = scroll;
    expect(jumpToTurn(page.turns[1])).toBe(true);
    expect(scroll).toHaveBeenCalledOnce();
    history.pushState({}, '', '/c/other');
    expect(jumpToTurn(page.turns[1])).toBe(false);
  });
});

describe('page lifecycle observation', () => {
  it('updates during streaming, ignores plugin-only changes and fully disconnects', async () => {
    fixture(message('user', '流式问题', 'u1') + message('assistant', '开始', 'a1'));
    const callback = vi.fn();
    const dispose = observePage(callback);
    expect(callback).toHaveBeenCalledTimes(1);
    const own = document.createElement('div');
    own.dataset.cgoRoot = '';
    document.querySelector('#history')!.prepend(own);
    own.textContent = '插件刷新';
    await vi.advanceTimersByTimeAsync(150);
    expect(callback).toHaveBeenCalledTimes(1);
    document.querySelector('[data-message-id="a1"] p')!.textContent = '开始继续回答';
    await vi.advanceTimersByTimeAsync(150);
    expect(callback.mock.calls.at(-1)![0].turns[0].answer).toBe('开始继续回答');
    dispose();
    const count = callback.mock.calls.length;
    document.querySelector('main')!.innerHTML = message('user', '停止之后');
    history.pushState({}, '', '/c/no-update');
    await vi.advanceTimersByTimeAsync(1000);
    expect(callback).toHaveBeenCalledTimes(count);
  });
  it('does not attribute the old conversation DOM to a new route while navigation is loading', async () => {
    fixture(message('user', '旧对话', 'u1') + message('assistant', '旧回答', 'a1'));
    const callback = vi.fn();
    const dispose = observePage(callback);
    history.pushState({}, '', '/c/new-chat');
    await vi.advanceTimersByTimeAsync(850);
    const loading = callback.mock.calls.at(-1)![0];
    expect(loading.conversationId).toBe('new-chat');
    expect(loading.turns).toHaveLength(0);
    expect(loading.readingRoot).toBe(document.querySelector('main'));
    expect(loading.conversations.some((item: { id: string }) => item.id === 'new-chat')).toBe(false);
    document.querySelector('[data-message-id="a1"] p')!.textContent = '旧对话仍在流式回答';
    await vi.advanceTimersByTimeAsync(150);
    expect(callback.mock.calls.at(-1)![0].turns).toHaveLength(0);
    document.querySelector('main')!.innerHTML = message('user', '新对话', 'new-user');
    document.title = '新对话 - ChatGPT';
    await vi.advanceTimersByTimeAsync(150);
    expect(callback.mock.calls.at(-1)![0].turns[0].question).toBe('新对话');
    dispose();
  });
  it('clears the old timeline while the new-chat page is replacing its DOM', async () => {
    fixture(message('user', '之前的对话', 'u1'));
    const callback = vi.fn();
    const dispose = observePage(callback);
    history.pushState({}, '', '/');
    await vi.advanceTimersByTimeAsync(850);
    expect(callback.mock.calls.at(-1)![0].conversationId).toBeNull();
    expect(callback.mock.calls.at(-1)![0].turns).toHaveLength(0);
    document.querySelector('main')!.innerHTML = '';
    await vi.advanceTimersByTimeAsync(150);
    expect(callback.mock.calls.at(-1)![0].title).not.toBe('正在加载对话…');
    dispose();
  });
  it('re-reads sidebar layout after a CSS-only responsive resize', async () => {
    fixture(message('user', '响应式侧栏', 'u1'));
    const callback = vi.fn();
    const dispose = observePage(callback);
    expect(callback.mock.calls.at(-1)![0].sidebar?.id).toBe('history');
    for (const node of document.querySelectorAll<HTMLElement>('aside, nav')) {
      node.getBoundingClientRect = () => ({ x: -260, y: 0, width: 260, height: 700, top: 0, bottom: 700, left: -260, right: 0, toJSON: () => ({}) });
    }
    window.dispatchEvent(new Event('resize'));
    await vi.advanceTimersByTimeAsync(150);
    expect(callback.mock.calls.at(-1)![0].sidebar).toBeNull();
    dispose();
  });
});
