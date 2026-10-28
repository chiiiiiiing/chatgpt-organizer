import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it } from 'vitest';
import { Backend, type Environment } from '../src/background/backend';
import { Database } from '../src/background/database';
import { compareRevision, nextRevision, putFolder, syncUsage, type SyncRecord } from '../src/background/model';
import { DEFAULT_SETTINGS, type Folder, type Snapshot } from '../src/shared/types';

const dbs: Database[] = [];
function client(cloud: Record<string, unknown>, dbName = crypto.randomUUID()) {
  const db = new Database(dbName); dbs.push(db);
  const control = { offline: false, writeFails: false, alarmFails: false, localFails: false, now: 1_800_000_000_000, scheduled: 0, writes: 0, writeAttempts: 0, reads: 0, notifications: 0 };
  const env: Environment = {
    getLocal: async () => DEFAULT_SETTINGS, setLocal: async () => { if (control.localFails) throw new Error('本地设置写入失败'); },
    getSync: async () => { control.reads++; if (control.offline) throw new Error('网络暂时不可用'); return structuredClone(cloud); },
    setSync: async (items) => { control.writeAttempts++; if (control.writeFails) throw new Error('MAX_WRITE_OPERATIONS_PER_MINUTE'); Object.assign(cloud, structuredClone(items)); control.writes++; },
    scheduleRetry: async (minutes) => { if (control.alarmFails) throw new Error('alarm unavailable'); control.scheduled = minutes; }, clearRetry: async () => { control.scheduled = 0; },
    changed: () => { control.notifications++; }, now: () => control.now,
  };
  return { db, backend: new Backend(db, env), control };
}
afterEach(async () => { await Promise.all(dbs.splice(0).map((db) => db.close())); });
async function create(backend: Backend, name: string) {
  const state = await backend.dispatch({ type: 'createFolder', name, parentId: null }) as Snapshot;
  await backend.dispatch({ type: 'getState' }); // Drain the background flush scheduled by the mutation.
  return state.folders.find((f) => f.name === name)!;
}

describe('browser sync transport', () => {
  it('updates an existing local title from a newer remote placement while preserving local seenAt', async () => {
    const a = client({});
    await a.backend.dispatch({ type: 'discover', conversations: [
      { id: 'renamed-chat', title: '本地旧标题', url: 'https://chatgpt.com/c/renamed-chat', seenAt: 12345 },
    ] });
    const record: SyncRecord = {
      kind: 'placement', value: {
        conversationId: 'renamed-chat', folderId: 'remote-folder', title: '远端新标题',
        url: 'https://chatgpt.com/g/g-project/c/renamed-chat', deleted: false,
        revision: { clock: 9, device: 'remote-device' },
      },
    };
    await a.backend.receiveRemote({ 'p:renamed-chat': { newValue: record } });
    const state = await a.backend.dispatch({ type: 'getState' }) as Snapshot;
    expect(state.conversations.find((ref) => ref.id === 'renamed-chat')).toEqual({
      id: 'renamed-chat', title: '远端新标题', url: 'https://chatgpt.com/g/g-project/c/renamed-chat', seenAt: 12345,
    });
  });
  it('honors backoff after a failure while allowing local edits, without syncing visual preferences', async () => {
    const a = client({}); a.control.writeFails = true; await create(a.backend, '首次写入');
    expect(a.control.writeAttempts).toBe(1);
    const reads = a.control.reads;
    await a.backend.dispatch({ type: 'settings', patch: { timelineExpanded: true } });
    await a.backend.dispatch({ type: 'getState' });
    expect(a.control.reads).toBe(reads);
    await create(a.backend, '退避期间的修改');
    expect(a.control.writeAttempts).toBe(1);
    expect((await a.backend.dispatch({ type: 'getState' }) as Snapshot).sync.pending).toBe(2);
    a.control.writeFails = false; a.control.now += 61000;
    await a.backend.flush();
    expect(a.control.writeAttempts).toBe(2);
    expect((await a.backend.dispatch({ type: 'getState' }) as Snapshot).sync.pending).toBe(0);
  });
  it('returns committed local edits if retry scheduling fails, but rejects a failed settings save', async () => {
    const a = client({}); a.control.alarmFails = true; a.control.offline = true;
    const created = await create(a.backend, '本地已保存');
    const saved = await a.backend.dispatch({ type: 'getState' }) as Snapshot;
    expect(saved.folders[0].id).toBe(created.id);
    expect(saved.sync.error).toContain('无法安排');
    a.control.localFails = true;
    await expect(a.backend.dispatch({ type: 'settings', patch: { timelineExpanded: true } })).rejects.toThrow('设置写入失败');
    expect((await a.backend.dispatch({ type: 'getState' }) as Snapshot).settings.timelineExpanded).toBe(false);
  });
  it('persists an offline outbox through worker restart and retries without losing local data', async () => {
    const cloud = {}; const dbName = crypto.randomUUID(); const a = client(cloud, dbName); a.control.offline = true;
    const folder = await create(a.backend, '离线分类');
    const offline = await a.backend.dispatch({ type: 'getState' }) as Snapshot;
    expect(offline.folders[0].id).toBe(folder.id); expect(offline.sync.pending).toBe(1); expect(offline.sync.error).toContain('网络');
    await a.db.close();
    const restarted = client(cloud, dbName); await restarted.backend.flush(true);
    const recovered = await restarted.backend.dispatch({ type: 'getState' }) as Snapshot;
    expect(recovered.sync.pending).toBe(0); expect(recovered.sync.lastSubmittedAt).toBe(restarted.control.now);
    expect(Object.keys(cloud)).toEqual([`f:${folder.id}`]);
  });
  it('converges offline concurrent edits by revision and keeps independent changes', async () => {
    const cloud: Record<string, unknown> = {}; const a = client(cloud); const b = client(cloud);
    const f = await create(a.backend, '原名'); await b.backend.flush(true);
    a.control.offline = true; b.control.offline = true;
    await a.backend.dispatch({ type: 'renameFolder', id: f.id, name: 'A 的名字' });
    await b.backend.dispatch({ type: 'renameFolder', id: f.id, name: 'B 的名字' });
    const ownA = await create(a.backend, 'A 独立分类'); const ownB = await create(b.backend, 'B 独立分类');
    const ra = (await a.db.read()).folders[f.id]; const rb = (await b.db.read()).folders[f.id];
    const winner = compareRevision(ra.revision, rb.revision) > 0 ? ra.name : rb.name;
    a.control.offline = false; b.control.offline = false;
    await a.backend.flush(true); await b.backend.flush(true); await a.backend.flush(true);
    const av = await a.backend.dispatch({ type: 'getState' }) as Snapshot;
    const bv = await b.backend.dispatch({ type: 'getState' }) as Snapshot;
    expect(av.folders.find((x) => x.id === f.id)?.name).toBe(winner);
    expect(bv.folders.find((x) => x.id === f.id)?.name).toBe(winner);
    expect(new Set(av.folders.map((x) => x.id))).toEqual(new Set([f.id, ownA.id, ownB.id]));
    expect(new Set(bv.folders.map((x) => x.id))).toEqual(new Set([f.id, ownA.id, ownB.id]));
  });
  it('keeps deletion tombstones so a stale device cannot revive deleted folders', async () => {
    const cloud: Record<string, unknown> = {}; const a = client(cloud); const b = client(cloud);
    const f = await create(a.backend, '将删除'); await b.backend.flush(true);
    await a.backend.dispatch({ type: 'deleteFolder', id: f.id }); await a.backend.flush(true); await b.backend.flush(true);
    expect((await b.backend.dispatch({ type: 'getState' }) as Snapshot).folders).toEqual([]);
    expect((await b.db.read()).folders[f.id].deleted).toBe(true);
    await b.backend.flush(true); await a.backend.flush(true);
    expect((cloud[`f:${f.id}`] as SyncRecord).value.deleted).toBe(true);
  });
  it('preserves raw folder references when a child or placement arrives before its parent', async () => {
    const cloud: Record<string, unknown> = {}; const a = client(cloud);
    const child: Folder = { id: 'child', parentId: 'parent', name: '子目录', order: 0, deleted: false, revision: { clock: 3, device: 'remote' } };
    const parent: Folder = { ...child, id: 'parent', parentId: null, name: '父目录', revision: { clock: 2, device: 'remote' } };
    const childRecord: SyncRecord = { kind: 'folder', value: child };
    cloud['f:child'] = childRecord;
    await a.backend.receiveRemote({ 'f:child': { newValue: childRecord } });
    expect((await a.backend.dispatch({ type: 'getState' }) as Snapshot).folders[0].parentId).toBeNull();
    expect((await a.db.read()).folders.child.parentId).toBe('parent');
    const parentRecord: SyncRecord = { kind: 'folder', value: parent };
    cloud['f:parent'] = parentRecord;
    await a.backend.receiveRemote({ 'f:parent': { newValue: parentRecord } });
    expect((await a.backend.dispatch({ type: 'getState' }) as Snapshot).folders.find((f) => f.id === 'child')?.parentId).toBe('parent');
  });
  it('syncs only filed metadata, not the discovered unclassified title index', async () => {
    const cloud: Record<string, unknown> = {}; const a = client(cloud);
    await a.backend.dispatch({ type: 'discover', conversations: [
      { id: 'filed', title: '分类对话', url: 'https://chatgpt.com/c/filed', seenAt: 1 },
      { id: 'private-local', title: '只在本机', url: 'https://chatgpt.com/c/private-local', seenAt: 1 },
    ] });
    const f = await create(a.backend, '分类');
    await a.backend.dispatch({ type: 'assign', conversationIds: ['filed'], folderId: f.id }); await a.backend.flush(true);
    expect(Object.keys(cloud).sort()).toEqual([`f:${f.id}`, 'p:filed'].sort());
    expect(JSON.stringify(cloud)).not.toContain('只在本机');
  });
  it('retains the complete local replica when sync item limits or write throttling are reached', async () => {
    const cloud: Record<string, unknown> = {}; const a = client(cloud);
    await a.db.update((state) => {
      for (let i = 0; i < 513; i++) putFolder(state, { id: `f${i}`, name: 'folder', parentId: null, order: i, deleted: false, revision: nextRevision(state) });
    });
    await a.backend.flush(true);
    const limited = await a.backend.dispatch({ type: 'getState' }) as Snapshot;
    expect(limited.folders).toHaveLength(513); expect(limited.sync.pending).toBe(513); expect(limited.sync.error).toContain('容量不足');
    expect(a.control.writes).toBe(0); expect(a.control.scheduled).toBeGreaterThan(0);
    const b = client({}); b.control.writeFails = true; await create(b.backend, '限流');
    expect((await b.backend.dispatch({ type: 'getState' }) as Snapshot).sync.pending).toBe(1);
    b.control.writeFails = false; await b.backend.flush(true);
    expect((await b.backend.dispatch({ type: 'getState' }) as Snapshot).sync.pending).toBe(0);
  });
  it('does not echo unchanged remote records endlessly and never labels submission as remote delivery', async () => {
    const cloud: Record<string, unknown> = {}; const a = client(cloud); const f = await create(a.backend, '测试');
    const count = a.control.writes;
    await a.backend.receiveRemote({ [`f:${f.id}`]: { newValue: cloud[`f:${f.id}`] } });
    await a.backend.flush(true); await a.backend.flush(true);
    expect(a.control.writes).toBe(count);
    const state = await a.backend.dispatch({ type: 'getState' }) as Snapshot;
    expect(state.sync.lastSubmittedAt).not.toBeNull();
    expect(Object.keys(state.sync)).not.toContain('delivered');
    expect(syncUsage(cloud).bytes).toBeGreaterThan(0);
  });
});
