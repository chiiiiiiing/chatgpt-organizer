import { DEFAULT_SETTINGS, type Backup, type Command, type Folder, type Settings, type Snapshot } from '../shared/types';
import { Database } from './database';
import {
  SETTINGS_KEY, SYNC_LIMITS, compareRevision, folderName, mergeRemote, nextRevision,
  normalizedFolders, parseSyncRecord, previewImport, putFolder, putPlacement,
  snapshot, subtreeIds, syncUsage, validateBackup, validateConversation,
  validateSettings, validId, type StoredState, type SyncRecord,
} from './model';

export interface Environment {
  getLocal(key: string): Promise<unknown>;
  setLocal(key: string, value: unknown): Promise<void>;
  getSync(): Promise<Record<string, unknown>>;
  setSync(items: Record<string, unknown>): Promise<void>;
  scheduleRetry(minutes: number): Promise<void>;
  clearRetry(): Promise<void>;
  changed(): void;
  now(): number;
}

export class Backend {
  private settings: Settings = { ...DEFAULT_SETTINGS, collapsedFolderIds: [] };
  private ready: Promise<void>;
  private tail: Promise<unknown> = Promise.resolve();
  constructor(readonly db: Database, private env: Environment) {
    this.ready = this.loadSettings();
  }
  private async loadSettings() {
    const saved = await this.env.getLocal(SETTINGS_KEY);
    if (saved !== undefined) {
      try { this.settings = validateSettings(saved) as Settings; }
      catch { /* An invalid settings record must not make the database inaccessible. */ }
    }
  }
  private serial<T>(task: () => Promise<T>): Promise<T> {
    const pending = this.tail.then(async () => { await this.ready; return task(); });
    this.tail = pending.catch(() => undefined);
    return pending;
  }
  private view(state: StoredState): Snapshot { return snapshot(state, structuredClone(this.settings)); }
  dispatch(command: Command): Promise<unknown> {
    return this.serial(async () => {
      if (!command || typeof command !== 'object' || typeof command.type !== 'string') throw new Error('无效的插件请求。');
      if (command.type === 'getState') return this.view(await this.db.read());
      if (command.type === 'syncNow') { await this.flushInternal(true); return this.view(await this.db.read()); }
      if (command.type === 'exportBackup') {
        const current = this.view(await this.db.read());
        return {
          schemaVersion: 1, exportedAt: new Date(this.env.now()).toISOString(),
          folders: current.folders, conversations: current.conversations,
          placements: current.placements, settings: current.settings,
        } satisfies Backup;
      }
      if (command.type === 'previewImport') return previewImport(await this.db.read(), validateBackup(command.backup));
      if (command.type === 'settings') {
        const patch = validateSettings(command.patch, true);
        const settings = { ...this.settings, ...patch };
        const enablingSync = !this.settings.syncEnabled && settings.syncEnabled;
        const disablingSync = this.settings.syncEnabled && !settings.syncEnabled;
        await this.env.setLocal(SETTINGS_KEY, settings);
        this.settings = settings;
        // Local visual preferences do not require reading or writing the sync area.
        if (enablingSync) { await this.scheduleRetry(0.5); void this.flush(true).catch(console.error); }
        else if (disablingSync) await this.env.clearRetry().catch(() => undefined);
        this.env.changed();
        return this.view(await this.db.read());
      }
      // Validate the full input before entering a write transaction.
      const backup = command.type === 'importBackup' ? validateBackup(command.backup) : null;
      const discoveries = command.type === 'discover' ? this.validateDiscoveries(command.conversations) : null;
      const state = await this.db.update((state) => {
        switch (command.type) {
          case 'discover': {
            for (const ref of discoveries!) {
              const previous = state.conversations[ref.id];
              if (!previous || ref.seenAt >= previous.seenAt) state.conversations[ref.id] = ref;
              const assigned = state.placements[ref.id];
              if (assigned && !assigned.deleted && (assigned.title !== ref.title || assigned.url !== ref.url)) {
                putPlacement(state, { ...assigned, title: ref.title, url: ref.url, revision: nextRevision(state) });
              }
            }
            break;
          }
          case 'createFolder': {
            const name = folderName(command.name);
            const folders = normalizedFolders(state.folders);
            this.ensureParentDepth(folders, command.parentId, 1);
            const siblings = folders.filter((f) => f.parentId === command.parentId);
            putFolder(state, { id: crypto.randomUUID(), name, parentId: command.parentId,
              order: Math.max(-1, ...siblings.map((f) => f.order)) + 1,
              revision: nextRevision(state), deleted: false });
            break;
          }
          case 'renameFolder': {
            const folder = this.liveFolder(state, command.id);
            putFolder(state, { ...folder, name: folderName(command.name), revision: nextRevision(state) });
            break;
          }
          case 'moveFolder': {
            const folders = normalizedFolders(state.folders);
            const folder = this.liveFolder(state, command.id);
            const descendants = subtreeIds(folders, command.id);
            if (command.parentId !== null && descendants.has(command.parentId)) throw new Error('不能将文件夹移入自己或其子文件夹。');
            const byId = new Map(folders.map((f) => [f.id, f]));
            let height = 1;
            for (const id of descendants) {
              let f = byId.get(id)!; let distance = 1;
              while (f.id !== command.id && f.parentId) { distance++; f = byId.get(f.parentId)!; }
              height = Math.max(height, distance);
            }
            this.ensureParentDepth(folders, command.parentId, height);
            const siblings = folders.filter((f) => f.parentId === command.parentId && f.id !== command.id);
            let at = siblings.length;
            if (command.beforeId != null) {
              at = siblings.findIndex((f) => f.id === command.beforeId);
              if (at < 0) throw new Error('排序目标已改变，请重试。');
            }
            siblings.splice(at, 0, { ...folder, parentId: command.parentId });
            // Compact sibling positions; every changed entity gets its own revision.
            siblings.forEach((f, index) => {
              const original = state.folders[f.id];
              if (f.id === folder.id || original.order !== index) putFolder(state, { ...f, order: index, revision: nextRevision(state) });
            });
            break;
          }
          case 'deleteFolder': {
            this.liveFolder(state, command.id);
            const ids = subtreeIds(normalizedFolders(state.folders), command.id);
            for (const id of ids) putFolder(state, { ...state.folders[id], deleted: true, revision: nextRevision(state) });
            for (const p of Object.values(state.placements)) if (!p.deleted && p.folderId !== null && ids.has(p.folderId)) {
              putPlacement(state, { ...p, folderId: null, deleted: true, revision: nextRevision(state) });
            }
            break;
          }
          case 'assign': {
            if (!Array.isArray(command.conversationIds) || command.conversationIds.length > 5000 || !command.conversationIds.every(validId)) throw new Error('请选择有效的对话。');
            if (command.folderId !== null) this.liveFolder(state, command.folderId);
            for (const id of new Set(command.conversationIds)) {
              const ref = state.conversations[id];
              const old = state.placements[id];
              if (!ref && !old) throw new Error('对话尚未收录，请先在 ChatGPT 中打开它。');
              if (old?.folderId === command.folderId && old.deleted === (command.folderId === null)) continue;
              putPlacement(state, {
                conversationId: id, folderId: command.folderId, title: ref?.title ?? old.title, url: ref?.url ?? old.url,
                deleted: command.folderId === null, revision: nextRevision(state),
              });
            }
            break;
          }
          case 'importBackup': {
            for (const f of backup!.folders) if (!(f.id in state.folders)) putFolder(state, { ...f, revision: nextRevision(state) });
            for (const c of backup!.conversations) if (!(c.id in state.conversations)) state.conversations[c.id] = c;
            for (const p of backup!.placements) if (!(p.conversationId in state.placements)) putPlacement(state, { ...p, revision: nextRevision(state) });
            // Existing local preferences (including sync consent) are intentionally preserved.
            break;
          }
          default: throw new Error('不支持此操作。');
        }
        return structuredClone(state);
      });
      this.env.changed();
      if (this.settings.syncEnabled && Object.keys(state.outbox).length) {
        await this.scheduleRetry(Math.max(0.5, ((state.nextRetryAt ?? 0) - this.env.now()) / 60000));
        void this.flush().catch(console.error);
      }
      return this.view(await this.db.read());
    });
  }
  private validateDiscoveries(input: unknown) {
    if (!Array.isArray(input) || input.length > 2000) throw new Error('一次收录的对话数量过多。');
    return input.map(validateConversation);
  }
  private liveFolder(state: StoredState, id: string): Folder {
    const folder = normalizedFolders(state.folders).find((f) => f.id === id);
    if (!folder) throw new Error('文件夹不存在或已删除，请刷新列表。');
    return folder;
  }
  private ensureParentDepth(folders: Folder[], parentId: string | null, height: number) {
    const map = new Map(folders.map((f) => [f.id, f]));
    let parent = parentId; let depth = 0;
    while (parent !== null) {
      const folder = map.get(parent);
      if (!folder) throw new Error('父文件夹不存在。');
      depth++; parent = folder.parentId;
    }
    if (depth + height > 3) throw new Error('文件夹最多支持三级，不能再嵌套。');
  }

  flush(force = false): Promise<void> { return this.serial(() => this.flushInternal(force)); }

  private async scheduleRetry(minutes: number): Promise<void> {
    try { await this.env.scheduleRetry(minutes); }
    catch (error) {
      // Scheduling is ancillary: a committed local edit must not be reported as failed.
      await this.db.update((state) => {
        state.sync.error = `本地已保存，但无法安排自动同步重试：${error instanceof Error ? error.message : String(error)}`;
      });
      this.env.changed();
    }
  }

  private async flushInternal(force: boolean): Promise<void> {
    if (!this.settings.syncEnabled) return;
    const before = await this.db.read();
    if (!force && (before.nextRetryAt ?? 0) > this.env.now()) {
      await this.scheduleRetry(Math.max(0.5, (before.nextRetryAt! - this.env.now()) / 60000));
      return;
    }
    try {
      const remote = await this.env.getSync();
      const records: SyncRecord[] = [];
      let invalid = false;
      for (const [key, value] of Object.entries(remote)) {
        if (!key.startsWith('f:') && !key.startsWith('p:')) continue;
        try { records.push(parseSyncRecord(key, value)); } catch { invalid = true; }
      }
      let state = await this.db.update((state) => {
        mergeRemote(state, records);
        // Restore missing sync keys from the durable local replica, never from DOM text.
        for (const f of Object.values(state.folders)) if (!Object.hasOwn(remote, `f:${f.id}`)) state.outbox[`f:${f.id}`] = { kind: 'folder', value: f };
        for (const p of Object.values(state.placements)) if (!Object.hasOwn(remote, `p:${p.conversationId}`)) state.outbox[`p:${p.conversationId}`] = { kind: 'placement', value: p };
        const usage = syncUsage(remote);
        state.sync.bytes = usage.bytes; state.sync.items = usage.items;
        return structuredClone(state);
      });
      if (!Object.keys(state.outbox).length) {
        await this.db.update((state) => { state.sync.error = invalid ? '有无法识别的同步记录，已保留本地数据。请先导出备份。' : null; state.retryCount = 0; state.nextRetryAt = null; });
        await this.env.clearRetry(); this.env.changed(); return;
      }
      const usage = syncUsage({ ...remote, ...state.outbox });
      if (usage.items > SYNC_LIMITS.items || usage.bytes > SYNC_LIMITS.bytes || usage.largest > SYNC_LIMITS.itemBytes) {
        throw new Error('浏览器同步容量不足（100 KB / 512 项 / 单项 8 KB）。所有更改已保存在本机，请导出备份；删除标记也占同步空间。');
      }
      if (!force && state.sync.lastSubmittedAt !== null && this.env.now() - state.sync.lastSubmittedAt < 2500) {
        await this.scheduleRetry(0.5); this.env.changed(); return;
      }
      const sent = structuredClone(state.outbox);
      await this.env.setSync(sent);
      await this.db.update((current) => {
        for (const [key, record] of Object.entries(sent)) {
          const pending = current.outbox[key];
          if (pending && compareRevision(pending.value.revision, record.value.revision) === 0) delete current.outbox[key];
        }
        current.sync.lastSubmittedAt = this.env.now();
        current.sync.error = invalid ? '有无法识别的同步记录，已保留本地数据。' : null;
        current.sync.bytes = usage.bytes; current.sync.items = usage.items; current.retryCount = 0; current.nextRetryAt = null;
      });
      await this.env.clearRetry();
      this.env.changed();
    } catch (error) {
      const retry = await this.db.update((state) => {
        state.sync.error = error instanceof Error ? error.message : '浏览器同步暂时不可用，本地数据已保留。';
        state.retryCount = Math.min(7, state.retryCount + 1);
        state.nextRetryAt = this.env.now() + Math.min(60, 2 ** (state.retryCount - 1)) * 60000;
        return state.retryCount;
      });
      await this.scheduleRetry(Math.min(60, 2 ** (retry - 1)));
      this.env.changed();
    }
  }

  receiveRemote(changes: Record<string, { newValue?: unknown }>): Promise<void> {
    return this.serial(async () => {
      if (!this.settings.syncEnabled) return;
      const incoming: SyncRecord[] = [];
      for (const [key, change] of Object.entries(changes)) {
        if ((!key.startsWith('f:') && !key.startsWith('p:')) || change.newValue === undefined) continue;
        try { incoming.push(parseSyncRecord(key, change.newValue)); } catch { /* Keep trustworthy local state. */ }
      }
      if (!incoming.length) return;
      const pending = await this.db.update((state) => {
        mergeRemote(state, incoming);
        return Object.keys(state.outbox).length;
      });
      this.env.changed();
      if (pending) { await this.scheduleRetry(0.5); void this.flush().catch(console.error); }
    });
  }
}
