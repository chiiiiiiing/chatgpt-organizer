import './style.css';
import { request } from '../shared/client';
import type { Backup, ImportPreview, Snapshot } from '../shared/types';

const app = document.querySelector<HTMLElement>('#app')!;
app.innerHTML = `
<header class="topbar"><a href="https://chatgpt.com/" target="_blank" rel="noreferrer" class="brand"><span class="brand-icon">▤</span><span>整理空间<span class="brand-sub">FOR CHATGPT</span></span></a><span class="version">0.1.1 · 个人版</span></header>
<div class="heading"><div class="eyebrow">A LITTLE MORE ORDER</div><h1>让每次对话，都有归处。</h1><p>分类、回看、继续思考。你的对话仍在 ChatGPT，整理方式由你决定。</p></div>
<section class="stats" aria-label="数据概览"><div><span id="folder-count">—</span><label>个文件夹</label></div><div><span id="filed-count">—</span><label>条已归类对话</label></div><div><span id="known-count">—</span><label>条已收录标题</label></div></section>
<div class="grid"><section class="card"><div class="card-header"><span class="card-icon">⇄</span><div><h2>分类同步</h2><p>同一种浏览器，同一个浏览器账号</p></div><label class="switch"><input id="sync-enabled" type="checkbox" aria-label="启用浏览器账号同步"><span></span></label></div>
<div class="sync-state"><span class="status-dot"></span><strong id="sync-label">正在读取本机数据…</strong></div><p class="subtle" id="sync-detail"></p>
<div class="quota"><div><span>上次检查的同步空间</span><span id="quota-label">—</span></div><progress id="quota" max="102400" value="0"></progress><small id="item-label"></small></div>
<div class="actions"><button id="sync-now" class="button secondary">检查并提交同步</button><span id="last-sync" class="tiny"></span></div>
<div class="note">同步文件夹、归类关系和已归类对话的标题与地址。未归类标题索引只留在本机；问答正文不保存、不上传。浏览器接收写入后，其他设备何时收到由浏览器决定。</div>
<details><summary>同步需要满足哪些条件？</summary><p>两端手动安装同一份插件，登录相同的浏览器账号，并在浏览器设置中启用扩展同步。Chrome 与 Edge 的账号同步不互通，可通过备份迁移。</p><p>“已交给浏览器同步”只代表本机写入成功。Chrome / Edge 的实际双设备到达情况需自行核对，当前版本没有远端确认机制。关闭同步不会删除已有云端副本。</p></details></section>
<section class="card"><div class="card-header"><span class="card-icon">↓</span><div><h2>备份与迁移</h2><p>一份 JSON，保留你的整理方式</p></div></div><div class="backup-art"><span>▱</span><div><strong>整理数据备份</strong><p>文件夹 · 归类 · 标题索引 · 界面设置</p><small>不包含问答正文、Cookie 或登录凭证</small></div></div><div class="actions"><button id="export" class="button primary">导出备份</button><button id="choose-import" class="button secondary">导入 JSON</button><input id="import-file" type="file" accept=".json,application/json" hidden></div><div id="import-preview" class="import-preview" hidden><strong>导入预览</strong><p id="preview-count"></p><p class="tiny">按 ID 合并；相同 ID 保留现有记录。导入不会替换你的界面设置。</p><div class="actions"><button id="confirm-import" class="button primary">确认合并</button><button id="cancel-import" class="button secondary">取消</button></div></div><div class="note">卸载插件会移除本机数据。更换浏览器或设备前，建议导出一份备份。文件包含对话标题与地址，请妥善保存。</div></section>
<section class="card appearance"><div class="card-header"><span class="card-icon">☷</span><div><h2>阅读与导航</h2><p>默认跟随 ChatGPT 的浅色或深色主题</p></div></div><label class="setting-row"><span><strong>显示问答时间轴</strong><small>右侧节点可预览并跳转到某轮问答</small></span><input id="timeline-visible" type="checkbox"></label><label class="setting-row"><span><strong>展开问题目录</strong><small>常驻显示问题摘要及当前对话搜索</small></span><input id="timeline-expanded" type="checkbox"></label><label class="setting-row"><span><strong>展开左侧整理面板</strong><small>收起后保留一个紧凑入口</small></span><input id="organizer-expanded" type="checkbox"></label></section>
<section class="card about"><div class="card-header"><span class="card-icon">◎</span><div><h2>关于收录范围</h2><p>逐步整理，不必一次处理全部历史</p></div></div><ol><li>侧栏加载过或你打开过的对话，会进入本机标题索引。</li><li>把对话拖入文件夹，或从菜单选择归类。支持三级文件夹，每条对话只有一个归属。</li><li>问答目录与正文搜索只覆盖当前页面已经读取的消息。向上滚动可加载更早内容。</li><li>删除文件夹只会解除分类，不会删除 ChatGPT 上的原对话。</li></ol><a class="open-chat" href="https://chatgpt.com/" target="_blank" rel="noreferrer">打开 ChatGPT <span>↗</span></a></section></div>
<footer>独立浏览器扩展 · 单一 ChatGPT 账号使用 · 无自建服务器 · 不调用付费 API</footer>
<div id="toast" class="toast" role="status" hidden></div>`;

const byId = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
let snapshot: Snapshot | null = null;
let pendingBackup: unknown;
let toastTimer: ReturnType<typeof setTimeout>;
function toast(message: string, error = false) {
  const el = byId('toast'); el.textContent = message; el.hidden = false; el.classList.toggle('error', error);
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { el.hidden = true; }, 6000);
}
function render(state: Snapshot) {
  snapshot = state;
  byId('folder-count').textContent = String(state.folders.length);
  byId('filed-count').textContent = String(state.placements.filter(p => !p.deleted && p.folderId).length);
  byId('known-count').textContent = String(state.conversations.length);
  byId<HTMLInputElement>('sync-enabled').checked = state.settings.syncEnabled;
  byId<HTMLInputElement>('timeline-visible').checked = !state.settings.timelineHidden;
  byId<HTMLInputElement>('timeline-expanded').checked = state.settings.timelineExpanded;
  byId<HTMLInputElement>('organizer-expanded').checked = !state.settings.organizerCollapsed;
  const sync = state.sync;
  byId('sync-label').textContent = !state.settings.syncEnabled ? '本地已保存 · 同步已暂停' : sync.error ? '本地已保存 · 同步需要处理' : sync.pending ? `本地已保存 · ${sync.pending} 项待提交` : sync.lastSubmittedAt ? '已交给浏览器同步' : '本地已保存 · 尚无同步提交';
  byId('sync-detail').textContent = sync.error || (state.settings.syncEnabled ? '此状态不代表其他设备已经收到数据。' : '已有的浏览器同步副本会保留；本机整理功能正常可用。');
  document.querySelector('.status-dot')!.classList.toggle('warning', Boolean(sync.error));
  byId('quota-label').textContent = `${(sync.bytes / 1024).toFixed(1)} / 100 KB`;
  byId<HTMLProgressElement>('quota').value = sync.bytes;
  byId('item-label').textContent = `${sync.items} / 512 条记录（包含删除标记）；每条记录最多 8 KB。`;
  byId('last-sync').textContent = sync.lastSubmittedAt ? `上次提交 ${new Date(sync.lastSubmittedAt).toLocaleString('zh-CN')}` : '';
  byId<HTMLButtonElement>('sync-now').disabled = !state.settings.syncEnabled;
}
async function refresh() {
  try { render(await request({ type: 'getState' })); }
  catch (error) { toast(`无法读取插件数据：${error instanceof Error ? error.message : error}`, true); }
}
async function run(button: HTMLButtonElement, action: () => Promise<void>) {
  button.disabled = true;
  try { await action(); } catch (error) { toast(error instanceof Error ? error.message : String(error), true); }
  finally { button.disabled = button.id === 'sync-now' && !snapshot?.settings.syncEnabled; }
}
byId<HTMLButtonElement>('sync-now').onclick = e => void run(e.currentTarget as HTMLButtonElement, async () => {
  render(await request({ type: 'syncNow' })); toast('已检查本机同步队列，请查看上方状态。');
});
for (const [id, key, invert] of [['sync-enabled', 'syncEnabled', false], ['timeline-visible', 'timelineHidden', true], ['timeline-expanded', 'timelineExpanded', false], ['organizer-expanded', 'organizerCollapsed', true]] as const) {
  byId<HTMLInputElement>(id).onchange = async e => {
    const value = (e.target as HTMLInputElement).checked;
    try { render(await request({ type: 'settings', patch: { [key]: invert ? !value : value } })); }
    catch (error) { if (snapshot) render(snapshot); toast(error instanceof Error ? error.message : String(error), true); }
  };
}
byId<HTMLButtonElement>('export').onclick = e => void run(e.currentTarget as HTMLButtonElement, async () => {
  const backup = await request<Backup>({ type: 'exportBackup' });
  const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob), a = document.createElement('a');
  a.href = url; a.download = `chatgpt-organizer-${new Date().toISOString().slice(0, 10)}.json`; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 30000); toast('备份已导出。');
});
byId('choose-import').onclick = () => byId<HTMLInputElement>('import-file').click();
byId<HTMLInputElement>('import-file').onchange = async e => {
  const input = e.target as HTMLInputElement, file = input.files?.[0]; input.value = ''; if (!file) return;
  pendingBackup = undefined; byId('import-preview').hidden = true;
  try {
    if (file.size > 10 * 1024 * 1024) throw new Error('备份超过 10 MB，请选择较小的 JSON 文件。');
    const data: unknown = JSON.parse(await file.text());
    const preview = await request<ImportPreview>({ type: 'previewImport', backup: data });
    pendingBackup = data;
    byId('preview-count').textContent = `将新增 ${preview.folders} 个文件夹、${preview.conversations} 条对话标题、${preview.placements} 条归类；保留现有 ${preview.skipped} 条同 ID 记录。`;
    byId('import-preview').hidden = false;
  } catch (error) { toast(error instanceof Error ? error.message : '不是有效的备份 JSON 文件。', true); }
};
byId('cancel-import').onclick = () => { pendingBackup = undefined; byId('import-preview').hidden = true; };
byId<HTMLButtonElement>('confirm-import').onclick = e => void run(e.currentTarget as HTMLButtonElement, async () => {
  if (!pendingBackup) return;
  render(await request({ type: 'importBackup', backup: pendingBackup }));
  pendingBackup = undefined; byId('import-preview').hidden = true; toast('备份已合并，本地原有记录保持不变。');
});
let port: chrome.runtime.Port | null = null;
function connect() {
  try {
    port = chrome.runtime.connect({ name: 'settings' });
    port.onMessage.addListener(message => { if (message?.type === 'changed') void refresh(); });
    port.onDisconnect.addListener(() => { port = null; setTimeout(connect, 1500); });
  } catch { /* Refreshing the extension invalidates this page; reload restores it. */ }
}
window.addEventListener('focus', () => void refresh());
connect(); void refresh();
