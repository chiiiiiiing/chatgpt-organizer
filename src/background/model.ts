import { DEFAULT_SETTINGS, type Backup, type ConversationRef, type Folder, type ImportPreview, type Placement, type Revision, type Settings, type Snapshot, type SyncStatus } from '../shared/types';

export type SyncRecord = { kind: 'folder'; value: Folder } | { kind: 'placement'; value: Placement };
export interface StoredState {
  schemaVersion: 1; deviceId: string; clock: number;
  folders: Record<string, Folder>; conversations: Record<string, ConversationRef>;
  placements: Record<string, Placement>; outbox: Record<string, SyncRecord>;
  sync: SyncStatus; retryCount: number; nextRetryAt: number | null;
}
export const MAX_BACKUP_BYTES = 10 * 1024 * 1024;
export const SYNC_LIMITS = { bytes: 102400, itemBytes: 8192, items: 512 };
export const SETTINGS_KEY = 'organizer.settings.v1';
export const SYNC_ALARM = 'organizer.sync.retry';
export const newState = (): StoredState => ({
  schemaVersion: 1, deviceId: crypto.randomUUID(), clock: 0,
  folders: {}, conversations: {}, placements: {}, outbox: {},
  sync: { pending: 0, error: null, lastSubmittedAt: null, bytes: 0, items: 0 }, retryCount: 0, nextRetryAt: null,
});
const compareId = (a: string, b: string): number => a === b ? 0 : a < b ? -1 : 1;
export const compareRevision = (a: Revision, b: Revision): number => a.clock - b.clock || compareId(a.device, b.device);
export const nextRevision = (state: StoredState): Revision => {
  if (state.clock >= Number.MAX_SAFE_INTEGER - 1) throw new Error('数据版本超出支持范围，请从备份恢复。');
  return { clock: ++state.clock, device: state.deviceId };
};
export const syncKey = (record: SyncRecord): string => record.kind === 'folder' ? `f:${record.value.id}` : `p:${record.value.conversationId}`;
export function putFolder(state: StoredState, folder: Folder): void {
  state.folders[folder.id] = folder;
  state.outbox[syncKey({ kind: 'folder', value: folder })] = { kind: 'folder', value: folder };
}
export function putPlacement(state: StoredState, placement: Placement): void {
  state.placements[placement.conversationId] = placement;
  state.outbox[syncKey({ kind: 'placement', value: placement })] = { kind: 'placement', value: placement };
}

function ensure(condition: unknown, message = '备份格式不正确。'): asserts condition {
  if (!condition) throw new Error(message);
}
const forbidden = new Set([...Object.getOwnPropertyNames(Object.prototype), 'prototype']);
export function validId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,160}$/.test(value) && !forbidden.has(value);
}
function object(value: unknown): asserts value is Record<string, unknown> {
  ensure(value !== null && typeof value === 'object' && !Array.isArray(value));
  ensure(Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
  ensure(!Object.keys(value).some((key) => forbidden.has(key)), '数据包含不安全的字段。');
}
function exactKeys(value: Record<string, unknown>, keys: string[]) {
  ensure(Object.keys(value).every((key) => keys.includes(key)), '数据包含未知字段，请检查备份版本。');
}
export function folderName(value: unknown): string {
  ensure(typeof value === 'string' && value.trim().length > 0 && value.trim().length <= 80, '文件夹名称需为 1–80 个字符。');
  return value.trim();
}
function revision(value: unknown): Revision {
  object(value); exactKeys(value, ['clock', 'device']);
  ensure(Number.isSafeInteger(value.clock) && Number(value.clock) >= 0 && Number(value.clock) < Number.MAX_SAFE_INTEGER - 1 && validId(value.device), '数据版本不正确。');
  return { clock: value.clock as number, device: value.device as string };
}
export function validateConversation(value: unknown): ConversationRef {
  object(value); exactKeys(value, ['id', 'title', 'url', 'seenAt']);
  ensure(validId(value.id), '对话 ID 不正确。');
  ensure(typeof value.title === 'string' && value.title.length > 0 && value.title.length <= 512, '对话标题过长或为空。');
  ensure(typeof value.url === 'string' && value.url.length < 2048, '对话链接不正确。');
  let url: URL;
  try { url = new URL(value.url); } catch { throw new Error('对话链接不正确。'); }
  const match = url.pathname.match(/^\/(?:g\/[^/]+\/)?c\/([A-Za-z0-9_-]+)\/?$/);
  ensure(url.origin === 'https://chatgpt.com' && !url.username && !url.password && !url.search && !url.hash && match?.[1] === value.id, '只接受与 ID 匹配的 ChatGPT 对话链接。');
  ensure(typeof value.seenAt === 'number' && Number.isFinite(value.seenAt) && value.seenAt >= 0, '对话日期不正确。');
  return { id: value.id, title: value.title, url: url.href, seenAt: value.seenAt };
}
export function validateFolder(value: unknown): Folder {
  object(value); exactKeys(value, ['id', 'name', 'parentId', 'order', 'revision', 'deleted']);
  ensure(validId(value.id) && (value.parentId === null || validId(value.parentId)), '文件夹 ID 不正确。');
  ensure(typeof value.order === 'number' && Number.isFinite(value.order) && typeof value.deleted === 'boolean');
  return { id: value.id, name: folderName(value.name), parentId: value.parentId as string | null, order: value.order, revision: revision(value.revision), deleted: value.deleted };
}
export function validatePlacement(value: unknown): Placement {
  object(value); exactKeys(value, ['conversationId', 'folderId', 'title', 'url', 'revision', 'deleted']);
  ensure(validId(value.conversationId) && (value.folderId === null || validId(value.folderId)) && typeof value.deleted === 'boolean');
  const ref = validateConversation({ id: value.conversationId, title: value.title, url: value.url, seenAt: 0 });
  return { conversationId: ref.id, folderId: value.folderId as string | null, title: ref.title, url: ref.url, revision: revision(value.revision), deleted: value.deleted };
}
export function validateSettings(value: unknown, partial = false): Settings | Partial<Settings> {
  object(value); exactKeys(value, Object.keys(DEFAULT_SETTINGS));
  const result: Partial<Settings> = {};
  for (const key of ['organizerCollapsed', 'timelineExpanded', 'timelineHidden', 'syncEnabled'] as const) {
    if (partial && !(key in value)) continue;
    ensure(typeof value[key] === 'boolean', '设置格式不正确。');
    result[key] = value[key];
  }
  if (!partial || 'collapsedFolderIds' in value) {
    ensure(Array.isArray(value.collapsedFolderIds) && value.collapsedFolderIds.length <= 5000 && value.collapsedFolderIds.every(validId));
    result.collapsedFolderIds = [...new Set(value.collapsedFolderIds)];
  }
  return result;
}
export function parseSyncRecord(key: string, value: unknown): SyncRecord {
  object(value); exactKeys(value, ['kind', 'value']);
  let record: SyncRecord;
  if (value.kind === 'folder') record = { kind: 'folder', value: validateFolder(value.value) };
  else if (value.kind === 'placement') record = { kind: 'placement', value: validatePlacement(value.value) };
  else throw new Error('未知的同步数据类型。');
  ensure(syncKey(record) === key, '同步记录 ID 与键不一致。');
  return record;
}

/** Derive a valid tree without rewriting raw records: references may arrive out of order. */
export function normalizedFolders(folders: Record<string, Folder>): Folder[] {
  const live = Object.values(folders).filter((f) => !f.deleted).map((f) => ({ ...f }));
  const byId = new Map(live.map((f) => [f.id, f]));
  const sorted = [...live].sort((a, b) => compareId(a.id, b.id));
  for (const folder of sorted) {
    if (folder.parentId === folder.id || (folder.parentId !== null && !byId.has(folder.parentId))) folder.parentId = null;
  }
  for (const folder of sorted) {
    const chain: string[] = [];
    let current: Folder | undefined = folder;
    while (current) {
      const at = chain.indexOf(current.id);
      if (at !== -1) { byId.get([...chain.slice(at)].sort()[0])!.parentId = null; break; }
      chain.push(current.id);
      current = current.parentId ? byId.get(current.parentId) : undefined;
    }
  }
  for (const folder of sorted) {
    let depth = 1; let current = folder;
    while (current.parentId) { depth++; current = byId.get(current.parentId)!; }
    if (depth > 3) folder.parentId = null;
  }
  return live.sort((a, b) => a.order - b.order || compareId(a.id, b.id));
}
export function snapshot(state: StoredState, settings: Settings): Snapshot {
  const folders = normalizedFolders(state.folders);
  const alive = new Set(folders.map((f) => f.id));
  const placements = Object.values(state.placements).filter((p) => !p.deleted && p.folderId !== null && alive.has(p.folderId));
  const conversations = new Map(Object.values(state.conversations).map((ref) => [ref.id, ref]));
  for (const p of Object.values(state.placements)) {
    if (!conversations.has(p.conversationId)) conversations.set(p.conversationId, { id: p.conversationId, title: p.title, url: p.url, seenAt: 0 });
  }
  return {
    folders, placements, conversations: [...conversations.values()].sort((a, b) => b.seenAt - a.seenAt || a.title.localeCompare(b.title)),
    settings, sync: { ...state.sync, pending: Object.keys(state.outbox).length },
  };
}
export function subtreeIds(folders: Folder[], id: string): Set<string> {
  const ids = new Set([id]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const f of folders) if (f.parentId && ids.has(f.parentId) && !ids.has(f.id)) { ids.add(f.id); changed = true; }
  }
  return ids;
}

export function validateBackup(input: unknown): Backup {
  let encoded: string;
  try { encoded = JSON.stringify(input); } catch { throw new Error('备份不是有效的 JSON 数据。'); }
  ensure(typeof encoded === 'string' && new TextEncoder().encode(encoded).length <= MAX_BACKUP_BYTES, '备份过大，最大支持 10 MB。');
  object(input); exactKeys(input, ['schemaVersion', 'exportedAt', 'folders', 'conversations', 'placements', 'settings']);
  ensure(input.schemaVersion === 1, '不支持此备份版本，请使用 schemaVersion 1 的备份。');
  ensure(typeof input.exportedAt === 'string' && Number.isFinite(Date.parse(input.exportedAt)), '备份时间不正确。');
  ensure(Array.isArray(input.folders) && input.folders.length <= 5000 && Array.isArray(input.conversations) && input.conversations.length <= 50000 && Array.isArray(input.placements) && input.placements.length <= 50000, '备份记录数量超出支持范围。');
  const folders = input.folders.map(validateFolder);
  const conversations = input.conversations.map(validateConversation);
  const placements = input.placements.map(validatePlacement);
  const settings = validateSettings(input.settings) as Settings;
  ensure(new Set(folders.map((f) => f.id)).size === folders.length && new Set(conversations.map((c) => c.id)).size === conversations.length && new Set(placements.map((p) => p.conversationId)).size === placements.length, '备份包含重复 ID。');
  const folderMap = new Map(folders.filter((f) => !f.deleted).map((f) => [f.id, f]));
  for (const f of folderMap.values()) {
    const visited = new Set<string>(); let current: Folder | undefined = f;
    while (current) {
      ensure(!visited.has(current.id), '备份文件夹存在循环。'); visited.add(current.id);
      ensure(visited.size <= 3, '备份文件夹超过三级。');
      if (current.parentId === null) break;
      ensure(folderMap.has(current.parentId), '备份文件夹引用了不存在的父目录。');
      current = folderMap.get(current.parentId);
    }
  }
  const conversationIds = new Set(conversations.map((c) => c.id));
  for (const p of placements) {
    ensure(conversationIds.has(p.conversationId), '备份归类缺少对应的对话记录。');
    if (!p.deleted && p.folderId !== null) ensure(folderMap.has(p.folderId), '备份归类引用了不存在的文件夹。');
  }
  return { schemaVersion: 1, exportedAt: input.exportedAt, folders, conversations, placements, settings };
}
export function previewImport(state: StoredState, backup: Backup): ImportPreview {
  const folders = backup.folders.filter((f) => !(f.id in state.folders)).length;
  const conversations = backup.conversations.filter((c) => !(c.id in state.conversations)).length;
  const placements = backup.placements.filter((p) => !(p.conversationId in state.placements)).length;
  return { folders, conversations, placements, skipped: backup.folders.length + backup.conversations.length + backup.placements.length - folders - conversations - placements };
}

export function mergeRemote(state: StoredState, records: SyncRecord[]): void {
  for (const record of records) {
    const key = syncKey(record);
    const existing = record.kind === 'folder' ? state.folders[record.value.id] : state.placements[record.value.conversationId];
    state.clock = Math.max(state.clock, record.value.revision.clock);
    const comparison = existing ? compareRevision(record.value.revision, existing.revision) : 1;
    if (comparison > 0) {
      if (record.kind === 'folder') state.folders[record.value.id] = record.value;
      else {
        state.placements[record.value.conversationId] = record.value;
        const known = state.conversations[record.value.conversationId];
        if (known) state.conversations[record.value.conversationId] = {
          ...known, title: record.value.title, url: record.value.url,
        };
      }
      const pending = state.outbox[key];
      if (pending && compareRevision(pending.value.revision, record.value.revision) <= 0) delete state.outbox[key];
    } else if (comparison < 0 && existing) {
      state.outbox[key] = record.kind === 'folder' ? { kind: 'folder', value: existing as Folder } : { kind: 'placement', value: existing as Placement };
    } else if (state.outbox[key] && compareRevision(state.outbox[key].value.revision, record.value.revision) === 0) {
      delete state.outbox[key];
    }
  }
}
export function syncUsage(items: Record<string, unknown>): { bytes: number; items: number; largest: number } {
  const encoder = new TextEncoder();
  const sizes = Object.entries(items).map(([key, value]) => encoder.encode(key).length + encoder.encode(JSON.stringify(value)).length);
  return { bytes: sizes.reduce((sum, n) => sum + n, 0), items: sizes.length, largest: Math.max(0, ...sizes) };
}
