import css from './organizer.css?inline';
import type { Command, ConversationRef, Folder, PageSnapshot, Request, Snapshot } from '../shared/types';

type DropItem = { kind: 'folder'; id: string } | { kind: 'conversation'; conversation: ConversationRef };
type Icon = 'folder' | 'chevron' | 'plus' | 'more' | 'search' | 'settings' | 'chat' | 'close' | 'arrow' | 'archive';
const MIME = 'application/x-chatgpt-organizer';
const paths: Record<Icon, string[]> = {
  folder: ['M3 7V5.5A1.5 1.5 0 0 1 4.5 4H9l2 2h8.5A1.5 1.5 0 0 1 21 7.5v11a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18.5V7Z'],
  chevron: ['m9 5 7 7-7 7'], plus: ['M12 5v14M5 12h14'], more: ['M5 12h.01M12 12h.01M19 12h.01'],
  search: ['m20 20-5-5', 'M17 10a7 7 0 1 1-14 0 7 7 0 0 1 14 0Z'],
  settings: ['M4 7h16M4 17h16M8 4v6M16 14v6'],
  chat: ['M5 4h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H9l-6 3V6a2 2 0 0 1 2-2Z'],
  close: ['m6 6 12 12M18 6 6 18'], arrow: ['M5 12h14m-6-6 6 6-6 6'],
  archive: ['M4 8h16v12H4V8ZM3 4h18v4H3V4Zm6 8h6'],
};

function icon(name: Icon): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  for (const [key, value] of Object.entries({ viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': name === 'more' ? '3' : '1.7', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' })) svg.setAttribute(key, value);
  for (const d of paths[name]) { const path = document.createElementNS(svg.namespaceURI, 'path'); path.setAttribute('d', d); svg.append(path); }
  return svg;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text?: string): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag); element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function button(label: string, name?: Icon, className = 'icon-button'): HTMLButtonElement {
  const b = el('button', className); b.type = 'button'; b.title = label; b.setAttribute('aria-label', label);
  if (name) b.append(icon(name)); else b.textContent = label;
  return b;
}

function safeConversation(raw: string, title?: string): ConversationRef | null {
  try {
    const url = new URL(raw.trim(), 'https://chatgpt.com');
    if (url.origin !== 'https://chatgpt.com' || url.username || url.password) return null;
    const match = url.pathname.match(/^\/(?:g\/[^/]+\/)?c\/([a-zA-Z0-9_-]+)\/?$/);
    if (!match) return null;
    url.hash = ''; url.search = '';
    return { id: match[1], title: title?.trim() || '未命名对话', url: url.href, seenAt: Date.now() };
  } catch { return null; }
}

/** Folder UI. The parent owns the host element's placement, theme and lifecycle. */
export class Organizer {
  private readonly container = el('section', 'organizer');
  private readonly body = el('div', 'organizer-body');
  private readonly list = el('div', 'folder-list');
  private readonly search = el('input', 'search-input');
  private readonly clearSearch = button('清除标题搜索', 'close', 'search-clear icon-button');
  private readonly collapse = button('收起整理空间', 'chevron', 'collapse-button icon-button');
  private readonly summary = el('span', 'summary');
  private readonly current = button('整理当前对话', undefined, 'current-conversation');
  private readonly dialog = el('dialog', 'organizer-dialog');
  private readonly status = el('p', 'organizer-status');
  private snapshot: Snapshot | null = null;
  private page: PageSnapshot | null = null;
  private folderCache: Folder[] = [];
  private conversationCache: ConversationRef[] = [];
  private folderIndex = new Map<string, Folder>();
  private placementIndex = new Map<string, string>();
  private query = '';
  private unfiledExpanded = false;
  private limits = new Map<string, number>();
  private destroyed = false;
  private dragItem: DropItem | null = null;
  private pending = 0;
  private dialogError: HTMLElement | null = null;
  private renderedState = '';
  private readonly style: HTMLStyleElement;
  private readonly dragEndHandler = () => this.clearDrag();

  constructor(private root: ShadowRoot, private request: Request, private notify: (message: string) => void) {
    this.style = el('style'); this.style.textContent = css;
    this.container.setAttribute('aria-label', '对话整理空间');
    const header = el('header', 'organizer-header');
    this.collapse.addEventListener('click', () => {
      if (this.snapshot) void this.mutate({ type: 'settings', patch: { organizerCollapsed: !this.snapshot.settings.organizerCollapsed } });
    });
    const title = el('h2', 'organizer-title', '整理空间');
    const create = button('新建文件夹', 'plus'); create.addEventListener('click', () => this.folderForm(null));
    const settings = button('整理空间设置与备份', 'settings');
    settings.addEventListener('click', () => {
      void this.request<null>({ type: 'openSettings' }).catch(error => this.notify(this.errorText(error)));
    });
    header.append(this.collapse, title, this.summary, create, settings);

    const searchWrap = el('div', 'search-wrap');
    this.search.type = 'search'; this.search.placeholder = '搜索已收录的对话';
    this.search.setAttribute('aria-label', '搜索已收录的对话标题'); this.search.autocomplete = 'off';
    this.search.addEventListener('input', () => { this.query = this.search.value.trim().toLocaleLowerCase(); this.limits.delete('search'); this.renderList(); });
    this.search.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') { this.search.value = ''; this.query = ''; this.renderList(); event.stopPropagation(); }
    });
    this.clearSearch.addEventListener('click', () => { this.search.value = ''; this.query = ''; this.renderList(); this.search.focus(); });
    searchWrap.append(icon('search'), this.search, this.clearSearch);
    this.current.addEventListener('click', () => {
      if (!this.page?.conversationId) return;
      const conversation = this.conversations().find(c => c.id === this.page!.conversationId)
        ?? safeConversation(`https://chatgpt.com/c/${this.page.conversationId}`, this.page.title);
      if (conversation) this.moveConversationDialog(conversation);
    });
    this.status.textContent = '正在读取已收录的对话…'; this.status.setAttribute('role', 'status');
    this.body.append(searchWrap, this.current, this.list, this.status);
    this.container.append(header, this.body);
    this.root.append(this.style, this.container, this.dialog);
    this.dialog.addEventListener('click', event => { if (event.target === this.dialog) { const rect = this.dialog.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) this.dialog.close(); } });
    document.addEventListener('dragend', this.dragEndHandler, true);
    document.addEventListener('drop', this.dragEndHandler, true);
  }

  update(snapshot: Snapshot, page: PageSnapshot): void {
    if (this.destroyed) return;
    this.snapshot = snapshot; this.page = page;
    this.rebuildIndex();
    this.body.hidden = snapshot.settings.organizerCollapsed;
    this.collapse.classList.toggle('is-collapsed', snapshot.settings.organizerCollapsed);
    this.collapse.setAttribute('aria-expanded', String(!snapshot.settings.organizerCollapsed));
    this.collapse.setAttribute('aria-label', snapshot.settings.organizerCollapsed ? '展开整理空间' : '收起整理空间');
    this.collapse.title = snapshot.settings.organizerCollapsed ? '展开整理空间' : '收起整理空间';
    this.summary.textContent = String(this.conversations().length);
    this.current.hidden = !page.conversationId;
    const folder = this.folderFor(page.conversationId ?? '');
    this.current.replaceChildren(icon('archive'), el('span', '', folder ? `当前对话 · ${folder.name}` : '将当前对话移入文件夹'), icon('arrow'));
    // Streaming answers update PageSnapshot frequently; preserve the folder tree while its own data is unchanged.
    const renderedState = JSON.stringify([
      this.folderCache.map(f => [f.id, f.name, f.parentId, f.order]),
      this.conversationCache.map(c => [c.id, c.title, c.url, this.placementIndex.get(c.id)]),
      snapshot.settings.collapsedFolderIds, page.conversationId,
    ]);
    if (renderedState !== this.renderedState) {
      this.renderedState = renderedState;
      this.renderList();
    }
  }

  destroy(): void {
    this.destroyed = true;
    document.removeEventListener('dragend', this.dragEndHandler, true);
    document.removeEventListener('drop', this.dragEndHandler, true);
    if (this.dialog.open) this.dialog.close();
    this.dialog.remove(); this.container.remove(); this.style.remove();
  }

  private conversations(): ConversationRef[] {
    return this.conversationCache;
  }

  private folders(): Folder[] {
    return this.folderCache;
  }

  private rebuildIndex(): void {
    if (!this.snapshot) return;
    this.folderCache = this.snapshot.folders.filter(f => !f.deleted).sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
    this.folderIndex = new Map(this.folderCache.map(f => [f.id, f]));
    this.placementIndex = new Map(this.snapshot.placements.filter(p => !p.deleted && p.folderId && this.folderIndex.has(p.folderId)).map(p => [p.conversationId, p.folderId!]));
    const all = new Map(this.snapshot.conversations.map(c => [c.id, c]));
    for (const p of this.snapshot.placements) if (!p.deleted && !all.has(p.conversationId)) all.set(p.conversationId, { id: p.conversationId, title: p.title, url: p.url, seenAt: 0 });
    this.conversationCache = [...all.values()].filter(c => safeConversation(c.url)).sort((a, b) => b.seenAt - a.seenAt || a.id.localeCompare(b.id));
  }

  private folderFor(conversationId: string): Folder | undefined {
    const id = this.placementIndex.get(conversationId);
    return id ? this.folderIndex.get(id) : undefined;
  }

  private descendants(id: string): Set<string> {
    const ids = new Set([id]);
    let added = true;
    while (added) { added = false; for (const f of this.folders()) if (f.parentId && ids.has(f.parentId) && !ids.has(f.id)) { ids.add(f.id); added = true; } }
    return ids;
  }

  private depth(folder: Folder): number {
    let result = 1; let parent = folder.parentId; const seen = new Set([folder.id]);
    while (parent && !seen.has(parent)) { seen.add(parent); const next = this.folders().find(f => f.id === parent); if (!next) break; result++; parent = next.parentId; }
    return result;
  }

  private path(folder: Folder): string {
    const names = [folder.name]; const seen = new Set([folder.id]); let parent = folder.parentId;
    while (parent && !seen.has(parent)) { seen.add(parent); const next = this.folders().find(f => f.id === parent); if (!next) break; names.unshift(next.name); parent = next.parentId; }
    return names.join(' / ');
  }

  private renderList(): void {
    if (!this.snapshot || this.destroyed) return;
    const focusedKey = (this.root.activeElement as HTMLElement | null)?.dataset.focusKey;
    const oldScroll = this.list.scrollTop;
    this.clearSearch.hidden = !this.query;
    this.list.replaceChildren();
    const all = this.conversations(); const folders = this.folders();
    if (this.query) {
      const results = all.filter(c => c.title.toLocaleLowerCase().includes(this.query));
      this.list.append(el('div', 'list-caption', `标题匹配 · ${results.length} 条`));
      if (!results.length) this.list.append(el('p', 'empty-text', '没有找到匹配的标题。只搜索已收录的对话。'));
      this.renderConversationList(this.list, results, 'search', true, 60);
    } else {
      if (!folders.length) {
        const empty = el('div', 'folder-empty'); empty.append(icon('folder'), el('p', '', '给对话一个位置'), el('span', '', '新建文件夹，或将左侧对话拖入归类。'));
        const create = button('创建第一个文件夹', undefined, 'text-button'); create.addEventListener('click', () => this.folderForm(null)); empty.append(create); this.list.append(empty);
      }
      const tree = el('div', 'folder-tree'); tree.setAttribute('aria-label', '文件夹');
      const rendered = new Set<string>();
      const renderChildren = (parentId: string | null, target: HTMLElement, level: number) => {
        for (const folder of folders.filter(f => f.parentId === parentId)) {
          if (rendered.has(folder.id) || level > 3) continue; rendered.add(folder.id);
          const branch = el('div', 'folder-branch');
          const row = this.folderRow(folder, level); branch.append(row);
          if (!this.snapshot!.settings.collapsedFolderIds.includes(folder.id)) {
            const children = el('div', 'folder-contents');
            renderChildren(folder.id, children, level + 1);
            const chats = all.filter(c => this.folderFor(c.id)?.id === folder.id);
            this.renderConversationList(children, chats, folder.id, false, 30);
            if (!chats.length && !folders.some(f => f.parentId === folder.id)) children.append(el('span', 'folder-empty-hint', '拖入对话，或从对话菜单移入'));
            branch.append(children);
          }
          target.append(branch);
        }
      };
      renderChildren(null, tree, 1); this.list.append(tree);
      const rootDrop = el('div', 'root-drop', '移到文件夹顶层');
      rootDrop.dataset.drop = 'root';
      this.installDrop(rootDrop, null, true); this.list.append(rootDrop);
      const unfiled = all.filter(c => !this.folderFor(c.id));
      const unfiledRow = button('未分类', undefined, 'unfiled-header');
      unfiledRow.replaceChildren(icon('chevron'), el('span', '', '未分类'), el('span', 'count', String(unfiled.length)));
      unfiledRow.setAttribute('aria-expanded', String(this.unfiledExpanded));
      unfiledRow.classList.toggle('expanded', this.unfiledExpanded);
      unfiledRow.addEventListener('click', () => { this.unfiledExpanded = !this.unfiledExpanded; this.renderList(); });
      this.installDrop(unfiledRow, null, false); this.list.append(unfiledRow);
      if (this.unfiledExpanded) {
        const contents = el('div', 'unfiled-contents');
        this.renderConversationList(contents, unfiled, 'unfiled', false, 30);
        if (!unfiled.length) contents.append(el('p', 'empty-text', '暂时没有未分类的对话。'));
        this.list.append(contents);
      }
    }
    this.status.textContent = `已收录 ${all.length} 条 · 打开或加载更多聊天后更新`;
    this.list.scrollTop = oldScroll;
    if (focusedKey) Array.from(this.list.querySelectorAll<HTMLElement>('[data-focus-key]')).find(e => e.dataset.focusKey === focusedKey)?.focus({ preventScroll: true });
  }

  private folderRow(folder: Folder, level: number): HTMLElement {
    const row = el('div', 'folder-row'); row.draggable = true; row.dataset.folderId = folder.id; row.dataset.level = String(level);
    const toggle = button(`${this.snapshot!.settings.collapsedFolderIds.includes(folder.id) ? '展开' : '折叠'} ${folder.name}`, undefined, 'folder-toggle');
    const expanded = !this.snapshot!.settings.collapsedFolderIds.includes(folder.id);
    toggle.setAttribute('aria-expanded', String(expanded)); toggle.dataset.focusKey = `folder:${folder.id}`;
    toggle.classList.toggle('expanded', expanded);
    const name = el('span', 'folder-name', folder.name); name.title = this.path(folder);
    const count = this.conversations().filter(c => this.folderFor(c.id)?.id === folder.id).length;
    toggle.replaceChildren(icon('chevron'), icon('folder'), name, el('span', 'count', String(count)));
    toggle.addEventListener('click', () => {
      const ids = new Set(this.snapshot!.settings.collapsedFolderIds);
      if (ids.has(folder.id)) ids.delete(folder.id); else ids.add(folder.id);
      void this.mutate({ type: 'settings', patch: { collapsedFolderIds: [...ids] } });
    });
    const menu = button(`${folder.name} 文件夹操作`, 'more', 'row-menu icon-button'); menu.dataset.focusKey = `menu:${folder.id}`;
    menu.addEventListener('click', () => this.folderMenu(folder)); row.addEventListener('contextmenu', event => { event.preventDefault(); this.folderMenu(folder); });
    row.addEventListener('dragstart', event => { this.dragItem = { kind: 'folder', id: folder.id }; this.setDrag(event, this.dragItem); row.classList.add('dragging'); });
    this.installDrop(row, folder.id, false); row.append(toggle, menu); return row;
  }

  private renderConversationList(target: HTMLElement, conversations: ConversationRef[], key: string, withLocation: boolean, initial: number): void {
    const limit = this.limits.get(key) ?? initial;
    for (const conversation of conversations.slice(0, limit)) {
      const row = el('div', 'conversation-row'); row.dataset.conversationId = conversation.id; row.draggable = true;
      row.classList.toggle('current', conversation.id === this.page?.conversationId);
      const link = el('a', 'conversation-link'); link.href = conversation.url; link.title = conversation.title;
      link.dataset.focusKey = `chat:${conversation.id}`;
      if (conversation.id === this.page?.conversationId) link.setAttribute('aria-current', 'page');
      const text = el('span', 'conversation-text'); text.append(el('span', 'conversation-title', conversation.title));
      if (withLocation) text.append(el('span', 'conversation-location', this.folderFor(conversation.id)?.name ?? '未分类'));
      link.append(icon('chat'), text);
      const menu = button(`移动对话：${conversation.title}`, 'more', 'row-menu icon-button'); menu.dataset.focusKey = `chat-menu:${conversation.id}`;
      menu.addEventListener('click', () => this.moveConversationDialog(conversation));
      row.addEventListener('contextmenu', event => { event.preventDefault(); this.moveConversationDialog(conversation); });
      row.addEventListener('dragstart', event => { this.dragItem = { kind: 'conversation', conversation }; this.setDrag(event, this.dragItem); row.classList.add('dragging'); });
      row.append(link, menu); target.append(row);
    }
    if (conversations.length > limit) {
      const more = button(`显示更多（还有 ${conversations.length - limit} 条）`, undefined, 'show-more');
      more.addEventListener('click', () => { this.limits.set(key, limit + 60); this.renderList(); }); target.append(more);
    }
  }

  private setDrag(event: DragEvent, item: DropItem): void {
    if (!event.dataTransfer) return;
    event.dataTransfer.setData(MIME, JSON.stringify(item)); event.dataTransfer.effectAllowed = 'move';
    if (item.kind === 'conversation') { event.dataTransfer.setData('text/uri-list', item.conversation.url); event.dataTransfer.setData('text/plain', item.conversation.url); }
    this.container.classList.toggle('dragging-folder', item.kind === 'folder');
  }

  private parseDrop(event: DragEvent): DropItem | null {
    const transfer = event.dataTransfer; if (!transfer) return null;
    const own = transfer.getData(MIME);
    if (own) {
      try {
        const item = JSON.parse(own) as DropItem;
        if (item.kind === 'folder' && typeof item.id === 'string' && this.folders().some(f => f.id === item.id)) return item;
        if (item.kind === 'conversation') {
          const conversation = safeConversation(item.conversation?.url, item.conversation?.title);
          if (conversation) return { kind: 'conversation', conversation };
        }
      } catch { /* Only recognized URLs and local folder IDs are accepted. */ }
    }
    const lines = (transfer.getData('text/uri-list') || transfer.getData('text/plain')).split(/\r?\n/).filter(s => s && !s.startsWith('#'));
    for (const line of lines) {
      const conversation = safeConversation(line);
      if (conversation) {
        const known = this.conversations().find(c => c.id === conversation.id) ?? this.page?.conversations.find(c => c.id === conversation.id);
        return { kind: 'conversation', conversation: known ?? conversation };
      }
    }
    return null;
  }

  private installDrop(target: HTMLElement, folderId: string | null, rootOnly: boolean): void {
    target.addEventListener('dragover', event => {
      if (!event.dataTransfer || (rootOnly && this.dragItem?.kind !== 'folder')) return;
      if (!Array.from(event.dataTransfer.types).some(t => [MIME, 'text/uri-list', 'text/plain'].includes(t))) return;
      event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = 'move';
      const zone = this.dropZone(target, event, folderId);
      target.dataset.dropPosition = zone;
    });
    target.addEventListener('dragleave', event => { if (!target.contains(event.relatedTarget as Node | null)) delete target.dataset.dropPosition; });
    target.addEventListener('drop', event => {
      event.preventDefault(); event.stopPropagation(); const item = this.parseDrop(event); const zone = this.dropZone(target, event, folderId); delete target.dataset.dropPosition;
      if (!item) { this.notify('请拖入 ChatGPT 对话链接或文件夹。'); return; }
      if (rootOnly && item.kind !== 'folder') return;
      if (item.kind === 'conversation') { void this.assignConversation(item.conversation, folderId); return; }
      if (item.id === folderId) return;
      const folder = this.folders().find(f => f.id === folderId);
      if (folder && zone !== 'inside') {
        const siblings = this.folders().filter(f => f.parentId === folder.parentId && f.id !== item.id);
        const next = siblings[siblings.findIndex(f => f.id === folder.id) + 1];
        void this.mutate({ type: 'moveFolder', id: item.id, parentId: folder.parentId, beforeId: zone === 'before' ? folder.id : next?.id ?? null });
      } else {
        void this.mutate({ type: 'moveFolder', id: item.id, parentId: folderId });
      }
    });
  }

  private dropZone(target: HTMLElement, event: DragEvent, folderId: string | null): 'before' | 'inside' | 'after' {
    if (!folderId || this.dragItem?.kind !== 'folder') return 'inside';
    const bounds = target.getBoundingClientRect(); const fraction = (event.clientY - bounds.top) / Math.max(bounds.height, 1);
    return fraction < .24 ? 'before' : fraction > .76 ? 'after' : 'inside';
  }

  private clearDrag(): void {
    // Native drop's capture phase precedes the row handler: retain dragItem until it has read the intended zone.
    setTimeout(() => {
      this.dragItem = null; this.container.classList.remove('dragging-folder');
      this.root.querySelectorAll<HTMLElement>('[data-drop-position], .dragging').forEach(node => { delete node.dataset.dropPosition; node.classList.remove('dragging'); });
    }, 0);
  }

  private showDialog(title: string, description?: string): HTMLElement {
    this.dialog.replaceChildren();
    const header = el('div', 'dialog-header'); const heading = el('h3', '', title); heading.id = 'organizer-dialog-title';
    const close = button('关闭对话框', 'close'); close.addEventListener('click', () => this.dialog.close()); header.append(heading, close);
    this.dialog.setAttribute('aria-labelledby', heading.id); this.dialog.append(header);
    if (description) this.dialog.append(el('p', 'dialog-description', description));
    const content = el('div', 'dialog-content'); this.dialog.append(content);
    this.dialogError = el('p', 'dialog-error'); this.dialogError.setAttribute('role', 'alert'); this.dialogError.hidden = true; this.dialog.append(this.dialogError);
    if (!this.dialog.open) this.dialog.showModal();
    return content;
  }

  private formActions(form: HTMLFormElement, submitLabel: string, danger = false): void {
    const actions = el('div', 'dialog-actions');
    const cancel = button('取消', undefined, 'secondary-button'); cancel.addEventListener('click', () => this.dialog.close());
    const submit = button(submitLabel, undefined, danger ? 'danger-button' : 'primary-button'); submit.type = 'submit'; actions.append(cancel, submit); form.append(actions);
  }

  private folderForm(parentId: string | null, folder?: Folder): void {
    const content = this.showDialog(folder ? '重命名文件夹' : '新建文件夹', parentId ? `上级：${this.folders().find(f => f.id === parentId)?.name ?? '顶层'}` : '用主题或项目，整理你的对话。');
    const form = el('form'); const label = el('label', 'field-label', '文件夹名称'); const input = el('input', 'dialog-input');
    input.required = true; input.maxLength = 80; input.placeholder = '例如：课程学习、项目研发'; input.value = folder?.name ?? ''; label.append(input); form.append(label);
    this.formActions(form, folder ? '保存名称' : '创建文件夹'); content.append(form);
    form.addEventListener('submit', event => {
      event.preventDefault(); const name = input.value.trim();
      if (!name) { this.showError('请输入文件夹名称。'); input.focus(); return; }
      void this.submitDialog(form, folder ? { type: 'renameFolder', id: folder.id, name } : { type: 'createFolder', name, parentId });
    });
    queueMicrotask(() => { input.focus(); input.select(); });
  }

  private folderMenu(folder: Folder): void {
    const content = this.showDialog(folder.name, this.path(folder));
    const actions = el('div', 'menu-actions');
    const add = (label: string, onClick: () => void, disabled = false, danger = false) => {
      const b = button(label, undefined, danger ? 'menu-action danger' : 'menu-action'); b.disabled = disabled;
      b.addEventListener('click', onClick); actions.append(b);
    };
    add('新建子文件夹', () => this.folderForm(folder.id), this.depth(folder) >= 3);
    add('重命名', () => this.folderForm(folder.parentId, folder));
    add('移动文件夹…', () => this.moveFolderDialog(folder));
    const siblings = this.folders().filter(f => f.parentId === folder.parentId); const index = siblings.findIndex(f => f.id === folder.id);
    add('上移', () => { void this.submitDialog(actions, { type: 'moveFolder', id: folder.id, parentId: folder.parentId, beforeId: siblings[index - 1]?.id }); }, index <= 0);
    add('下移', () => { void this.submitDialog(actions, { type: 'moveFolder', id: folder.id, parentId: folder.parentId, beforeId: siblings[index + 2]?.id ?? null }); }, index >= siblings.length - 1);
    add('删除文件夹…', () => this.deleteFolderDialog(folder), false, true); content.append(actions);
  }

  private folderSelect(labelText: string, selected: string | null, rootLabel: string, allowed = this.folders()): { label: HTMLLabelElement; select: HTMLSelectElement } {
    const label = el('label', 'field-label', labelText); const select = el('select', 'dialog-select');
    const root = el('option', '', rootLabel); root.value = ''; select.append(root);
    const ordered = allowed.map(f => ({ folder: f, path: this.path(f) })).sort((a, b) => a.path.localeCompare(b.path, 'zh-CN'));
    for (const { folder, path } of ordered) { const option = el('option', '', path); option.value = folder.id; select.append(option); }
    select.value = selected ?? ''; label.append(select); return { label, select };
  }

  private moveFolderDialog(folder: Folder): void {
    const descendants = this.descendants(folder.id);
    const subtreeDepth = Math.max(...this.folders().filter(f => descendants.has(f.id)).map(f => this.depth(f))) - this.depth(folder) + 1;
    const allowed = this.folders().filter(f => !descendants.has(f.id) && this.depth(f) + subtreeDepth <= 3);
    const content = this.showDialog('移动文件夹', `“${folder.name}”及其内容一起移动，最多保留三级目录。`);
    const form = el('form'); const { label, select } = this.folderSelect('移入', folder.parentId, '文件夹顶层', allowed); form.append(label);
    this.formActions(form, '移动'); content.append(form);
    form.addEventListener('submit', event => { event.preventDefault(); void this.submitDialog(form, { type: 'moveFolder', id: folder.id, parentId: select.value || null }); });
  }

  private deleteFolderDialog(folder: Folder): void {
    const ids = this.descendants(folder.id);
    const count = this.conversations().filter(c => { const assigned = this.folderFor(c.id); return assigned && ids.has(assigned.id); }).length;
    const content = this.showDialog('删除文件夹？', `将删除“${folder.name}”${ids.size > 1 ? `及 ${ids.size - 1} 个子文件夹` : ''}。其中 ${count} 条对话会回到「未分类」，ChatGPT 原始聊天会保留。`);
    const form = el('form'); this.formActions(form, '删除文件夹', true); content.append(form);
    form.addEventListener('submit', event => { event.preventDefault(); void this.submitDialog(form, { type: 'deleteFolder', id: folder.id }); });
  }

  private moveConversationDialog(conversation: ConversationRef): void {
    const content = this.showDialog('移动对话', conversation.title);
    const form = el('form'); const { label, select } = this.folderSelect('目标位置', this.folderFor(conversation.id)?.id ?? null, '未分类'); form.append(label);
    if (!this.folders().length) {
      const create = button('先创建文件夹', undefined, 'text-button'); create.addEventListener('click', () => this.folderForm(null)); form.append(create);
    }
    this.formActions(form, '移动对话'); content.append(form);
    form.addEventListener('submit', event => {
      event.preventDefault();
      void this.withDisabled(form, async () => { await this.assignConversation(conversation, select.value || null, true); this.dialog.close(); });
    });
  }

  private async assignConversation(conversation: ConversationRef, folderId: string | null, propagate = false): Promise<void> {
    try {
      if (!this.snapshot?.conversations.some(c => c.id === conversation.id)) {
        const state = await this.request<Snapshot>({ type: 'discover', conversations: [conversation] });
        if (this.page) this.update(state, this.page);
      }
      await this.mutate({ type: 'assign', conversationIds: [conversation.id], folderId }, true);
      this.notify(folderId ? '对话已移入文件夹。' : '对话已移回未分类。');
    } catch (error) { if (propagate) throw error; this.notify(this.errorText(error)); }
  }

  private async submitDialog(form: HTMLElement, command: Command): Promise<void> {
    await this.withDisabled(form, async () => { await this.mutate(command, true); this.dialog.close(); });
  }

  private async withDisabled(form: HTMLElement, action: () => Promise<void>): Promise<void> {
    const controls = Array.from(form.querySelectorAll<HTMLButtonElement | HTMLInputElement | HTMLSelectElement>('button,input,select'));
    const disabled = controls.map(control => control.disabled); controls.forEach(control => control.disabled = true);
    if (this.dialogError) this.dialogError.hidden = true;
    try { await action(); } catch (error) { this.showError(this.errorText(error)); }
    finally { controls.forEach((control, i) => control.disabled = disabled[i]); }
  }

  private showError(message: string): void {
    if (this.dialogError) { this.dialogError.textContent = message; this.dialogError.hidden = false; }
  }

  private async mutate(command: Command, propagate = false): Promise<void> {
    this.pending++; this.container.setAttribute('aria-busy', 'true');
    try {
      const state = await this.request<Snapshot>(command);
      if (this.page && !this.destroyed) this.update(state, this.page);
    } catch (error) { if (propagate) throw error; this.notify(this.errorText(error)); }
    finally { if (--this.pending === 0) this.container.setAttribute('aria-busy', 'false'); }
  }

  private errorText(error: unknown): string { return error instanceof Error ? error.message : '操作未完成，请重试。'; }
}
