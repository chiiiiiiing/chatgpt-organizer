import type { PageSnapshot, Request, Settings, Turn } from '../shared/types';
import { jumpToTurn } from './adapter';
import css from './timeline.css?inline';

function element<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text = '') {
  const el = document.createElement(tag); el.className = cls; el.textContent = text; return el;
}
function excerpt(text: string, query = '', length = 110): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  const at = query ? flat.toLocaleLowerCase().indexOf(query.toLocaleLowerCase()) : -1;
  const start = Math.max(0, at - 30);
  return `${start ? '…' : ''}${flat.slice(start, start + length)}${flat.length > start + length ? '…' : ''}`;
}

export class Timeline {
  private shell = element('section', 'timeline');
  private rail = element('div', 'rail');
  private list = element('div', 'turn-list');
  private panel = element('div', 'panel');
  private preview = element('div', 'preview');
  private input = element('input', 'search');
  private count = element('span', 'count');
  private status = element('p', 'status');
  private expand = element('button', 'icon-button');
  private reveal = element('button', 'reveal', '☷');
  private turns: Turn[] = [];
  private page: PageSnapshot | null = null;
  private settings: Settings | null = null;
  private activeKey = '';
  private previewKey = '';
  private signature = '';
  private frame = 0;
  private controller = new AbortController();

  constructor(private root: ShadowRoot, private request: Request, private notify: (text: string) => void) {
    const style = element('style'); style.textContent = css;
    const railHeader = element('div', 'rail-header');
    this.expand.textContent = '☷'; this.expand.title = '展开问题目录'; this.expand.setAttribute('aria-label', '展开问题目录');
    this.expand.onclick = () => void this.change({ timelineExpanded: !this.settings?.timelineExpanded });
    const hide = element('button', 'icon-button hide', '×'); hide.title = '收起时间轴'; hide.setAttribute('aria-label', '收起时间轴');
    hide.onclick = () => void this.change({ timelineHidden: true });
    railHeader.append(this.expand, hide);
    const railWrap = element('div', 'rail-wrap'); railWrap.append(railHeader, this.rail);
    const heading = element('div', 'panel-heading');
    heading.append(element('strong', '', '问答目录'), this.count);
    const collapse = element('button', 'icon-button', '›'); collapse.title = '收起问题目录'; collapse.setAttribute('aria-label', '收起问题目录');
    collapse.onclick = () => void this.change({ timelineExpanded: false });
    heading.append(collapse);
    this.input.type = 'search'; this.input.placeholder = '搜索这段对话…'; this.input.setAttribute('aria-label', '搜索当前对话内容');
    this.input.addEventListener('input', () => this.render());
    this.input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { this.input.value = ''; this.render(); }
    });
    const scope = element('p', 'scope', '仅搜索已读取内容 · 向上滚动可加载更早问答');
    this.status.setAttribute('aria-live', 'polite');
    this.panel.append(heading, this.input, scope, this.list, this.status);
    this.preview.setAttribute('role', 'tooltip'); this.preview.id = 'turn-preview'; this.preview.hidden = true;
    this.shell.setAttribute('aria-label', '问答时间轴');
    this.shell.append(this.panel, railWrap, this.preview);
    this.reveal.title = '显示问答导航'; this.reveal.setAttribute('aria-label', '显示问答导航');
    this.reveal.onclick = () => void this.change({ timelineHidden: false });
    root.append(style, this.shell, this.reveal);
    const opts = { capture: true, passive: true, signal: this.controller.signal };
    document.addEventListener('scroll', this.onScroll, opts);
    window.addEventListener('resize', this.onScroll, opts);
    this.shell.addEventListener('keydown', e => { if (e.key === 'Escape') this.preview.hidden = true; });
  }

  private async change(patch: Partial<Settings>) {
    try { const result = await this.request({ type: 'settings', patch }); if (this.page) this.update(this.page, result.settings); }
    catch (err) { this.notify(err instanceof Error ? err.message : String(err)); }
  }

  update(page: PageSnapshot, settings: Settings) {
    const routeChanged = this.page?.conversationId !== page.conversationId;
    this.page = page; this.settings = settings; this.turns = page.turns;
    if (routeChanged) { this.input.value = ''; this.preview.hidden = true; this.previewKey = ''; this.activeKey = ''; }
    const host = this.root.host as HTMLElement;
    host.dataset.theme = page.dark ? 'dark' : 'light';
    this.shell.hidden = settings.timelineHidden;
    this.reveal.hidden = !settings.timelineHidden;
    this.shell.classList.toggle('expanded', settings.timelineExpanded);
    this.expand.title = settings.timelineExpanded ? '收起问题目录' : '展开问题目录';
    this.expand.setAttribute('aria-label', this.expand.title);
    this.expand.setAttribute('aria-expanded', String(settings.timelineExpanded));
    const signature = page.turns.map(t => `${t.key}\0${t.question}\0${t.answer}`).join('\n');
    if (signature !== this.signature || routeChanged) { this.signature = signature; this.render(); }
    this.count.textContent = `${this.turns.length} 轮`;
    this.onScroll();
  }

  private render() {
    const railScroll = this.rail.scrollTop, listScroll = this.list.scrollTop;
    const previewKey = this.preview.hidden ? '' : this.previewKey;
    const focused = this.root.activeElement as HTMLElement | null;
    const focusKey = focused?.dataset.key;
    const focusKind = focused?.classList.contains('node') ? 'node' : 'turn';
    const query = this.input.value.trim();
    const matches = this.turns.filter(t => !query || `${t.question}\n${t.answer}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
    this.rail.replaceChildren(); this.list.replaceChildren(); this.preview.hidden = true;
    for (const turn of this.turns) {
      const dot = element('button', 'node'); dot.dataset.key = turn.key;
      dot.setAttribute('aria-label', `第 ${turn.index + 1} 轮：${excerpt(turn.question, '', 70)}`);
      dot.setAttribute('aria-describedby', this.preview.id);
      dot.onclick = () => this.jump(turn);
      dot.onmouseenter = () => this.showPreview(turn, dot);
      dot.onmouseleave = () => { this.preview.hidden = true; this.previewKey = ''; };
      dot.onfocus = () => this.showPreview(turn, dot);
      dot.onblur = () => { this.preview.hidden = true; this.previewKey = ''; };
      this.rail.append(dot);
    }
    for (const turn of matches) {
      const item = element('button', 'turn'); item.dataset.key = turn.key;
      const label = element('span', 'turn-number', String(turn.index + 1).padStart(2, '0'));
      const body = element('span', 'turn-body');
      body.append(element('span', 'question', excerpt(turn.question, query, 120)));
      if (query && !turn.question.toLocaleLowerCase().includes(query.toLocaleLowerCase())) {
        body.append(element('span', 'answer-match', `回答：${excerpt(turn.answer, query, 120)}`));
      }
      item.append(label, body); item.onclick = () => this.jump(turn); this.list.append(item);
    }
    if (!this.turns.length) {
      this.list.append(element('div', 'empty', '在一段对话里开始导航'));
      this.status.textContent = '当前页面还没有读取到问答';
    } else if (!matches.length) {
      this.list.append(element('div', 'empty', '已读取内容中没有匹配结果'));
      this.status.textContent = '试试更短的关键词，或向上加载更早内容';
    } else this.status.textContent = query ? `找到 ${matches.length} 轮匹配问答` : `已读取 ${this.turns.length} 轮问答`;
    this.markActive();
    this.rail.scrollTop = railScroll; this.list.scrollTop = listScroll;
    if (focusKey) [...this.root.querySelectorAll<HTMLElement>('[data-key]')].find(el => el.dataset.key === focusKey && el.classList.contains(focusKind))?.focus({ preventScroll: true });
    if (previewKey) {
      const turn = this.turns.find(t => t.key === previewKey);
      const node = [...this.rail.querySelectorAll<HTMLElement>('.node')].find(n => n.dataset.key === previewKey);
      if (turn && node) this.showPreview(turn, node);
    }
  }

  private jump(turn: Turn) {
    // Rebind by key: streaming updates may replace a DOM node since this button was rendered.
    const current = this.turns.find(t => t.key === turn.key);
    if (!current || !jumpToTurn(current)) { this.notify('这条问答已不在当前页面中。请加载更早内容，或确认当前对话分支。'); return; }
    this.activeKey = current.key; this.markActive(); this.preview.hidden = true;
  }

  private showPreview(turn: Turn, node: HTMLElement) {
    const current = this.turns.find(t => t.key === turn.key); if (!current) return;
    this.previewKey = current.key;
    this.preview.replaceChildren(element('span', 'eyebrow', `第 ${current.index + 1} 轮`),
      element('strong', 'preview-question', excerpt(current.question, '', 220)),
      element('p', 'preview-answer', excerpt(current.answer || '回答尚未生成或加载', '', 260)),
      element('span', 'preview-hint', '点击节点回到这轮问答'));
    this.preview.hidden = false;
    const shellRect = this.shell.getBoundingClientRect(), rect = node.getBoundingClientRect();
    this.preview.style.top = `${Math.max(0, Math.min(rect.top - shellRect.top - 20, shellRect.height - this.preview.offsetHeight))}px`;
  }

  private onScroll = () => {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      const connected = this.turns.filter(t => t.element.isConnected);
      const inView = connected.filter(t => t.element.getBoundingClientRect().top <= 180);
      const candidate = inView.at(-1) ?? connected[0];
      if (candidate && this.activeKey !== candidate.key) { this.activeKey = candidate.key; this.markActive(); }
    });
  };

  private markActive() {
    for (const node of this.root.querySelectorAll<HTMLElement>('[data-key]')) {
      const active = node.dataset.key === this.activeKey;
      node.classList.toggle('active', active);
      if (active) node.setAttribute('aria-current', 'step'); else node.removeAttribute('aria-current');
    }
  }

  destroy() { this.controller.abort(); cancelAnimationFrame(this.frame); this.root.replaceChildren(); }
}
