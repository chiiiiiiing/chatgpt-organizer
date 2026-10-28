import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Backend, type Environment } from '../src/background/backend';
import { Database } from '../src/background/database';
import { DEFAULT_SETTINGS, type Backup, type Snapshot } from '../src/shared/types';
import { normalizedFolders, type StoredState } from '../src/background/model';

const databases: Database[] = [];
function setup(name = crypto.randomUUID()) {
  const db = new Database(name); databases.push(db);
  const values: Record<string, unknown> = {};
  const env: Environment = {
    getLocal: async () => ({ ...DEFAULT_SETTINGS, syncEnabled: false }),
    setLocal: async (key, value) => { values[key] = value; },
    getSync: async () => ({}), setSync: async () => undefined,
    scheduleRetry: async () => undefined, clearRetry: async () => undefined,
    changed: () => undefined, now: () => 1_800_000_000_000,
  };
  return { db, backend: new Backend(db, env), values };
}
afterEach(async () => { await Promise.all(databases.splice(0).map((db) => db.close())); });
const conversation = (id: string, title = id) => ({ id, title, url: `https://chatgpt.com/c/${id}`, seenAt: 1 });
async function folder(backend: Backend, name: string, parentId: string | null = null) {
  const state = await backend.dispatch({ type: 'createFolder', name, parentId }) as Snapshot;
  return state.folders.find((f) => f.name === name)!;
}

describe('durable organizer data', () => {
  it('does not rewrite the database while the UI refreshes or previews a backup', async () => {
    const { backend, db } = setup(); await folder(backend, '稳定数据');
    const write = vi.spyOn(db, 'update');
    await backend.dispatch({ type: 'getState' });
    const backup = await backend.dispatch({ type: 'exportBackup' }) as Backup;
    await backend.dispatch({ type: 'previewImport', backup });
    expect(write).not.toHaveBeenCalled();
  });
  it('enforces maximum depth, rejects moving ancestors into descendants, and preserves original data', async () => {
    const { backend } = setup();
    const a = await folder(backend, '科研'); const b = await folder(backend, '论文', a.id); const c = await folder(backend, '复现', b.id);
    await expect(folder(backend, '第四层', c.id)).rejects.toThrow('三级');
    await expect(backend.dispatch({ type: 'moveFolder', id: a.id, parentId: c.id })).rejects.toThrow('自己');
    expect((await backend.dispatch({ type: 'getState' }) as Snapshot).folders).toHaveLength(3);
  });
  it('moves one conversation between folders and deleting a subtree unfiles all its conversations', async () => {
    const { backend, db } = setup();
    const a = await folder(backend, '学习'); const b = await folder(backend, '数学', a.id); const other = await folder(backend, '工作');
    await backend.dispatch({ type: 'discover', conversations: [conversation('c1'), conversation('c2')] });
    await backend.dispatch({ type: 'assign', conversationIds: ['c1'], folderId: other.id });
    await backend.dispatch({ type: 'assign', conversationIds: ['c1', 'c2'], folderId: b.id });
    const assigned = await backend.dispatch({ type: 'getState' }) as Snapshot;
    expect(assigned.placements).toHaveLength(2);
    expect(assigned.placements.every((p) => p.folderId === b.id)).toBe(true);
    const removed = await backend.dispatch({ type: 'deleteFolder', id: a.id }) as Snapshot;
    expect(removed.folders.map((f) => f.id)).toEqual([other.id]);
    expect(removed.placements).toEqual([]);
    expect(removed.conversations).toHaveLength(2);
    const raw = await db.read();
    expect(raw.folders[a.id].deleted).toBe(true);
    expect(raw.placements.c1.deleted).toBe(true);
  });
  it('serializes separate callers through IndexedDB transactions, including rollbacks', async () => {
    const name = crypto.randomUUID(); const first = setup(name); const second = setup(name);
    await Promise.all(Array.from({ length: 24 }, (_, i) => folder(i % 2 ? first.backend : second.backend, `分类${i}`)));
    expect((await first.backend.dispatch({ type: 'getState' }) as Snapshot).folders).toHaveLength(24);
    const f = (await first.backend.dispatch({ type: 'getState' }) as Snapshot).folders[0];
    await first.backend.dispatch({ type: 'discover', conversations: [conversation('known')] });
    await expect(first.backend.dispatch({ type: 'assign', conversationIds: ['known', 'missing'], folderId: f.id })).rejects.toThrow('尚未收录');
    expect((await first.db.read()).placements.known).toBeUndefined();
  });
  it('restores state after reopening the database and never persists question/answer bodies', async () => {
    const name = crypto.randomUUID(); const first = setup(name);
    const f = await folder(first.backend, '持久分类');
    await first.backend.dispatch({ type: 'discover', conversations: [conversation('conv')] });
    await first.backend.dispatch({ type: 'assign', conversationIds: ['conv'], folderId: f.id });
    await first.db.close();
    const second = setup(name); const state = await second.backend.dispatch({ type: 'getState' }) as Snapshot;
    expect(state.placements[0].folderId).toBe(f.id);
    await expect(second.backend.dispatch({ type: 'discover', conversations: [{ ...conversation('bad'), answer: 'private text' }] as never })).rejects.toThrow('未知字段');
    expect(JSON.stringify(await second.db.read())).not.toContain('private text');
  });
  it('reorders folder siblings without changing their parent or dropping descendants', async () => {
    const { backend } = setup(); const a = await folder(backend, 'A'); const b = await folder(backend, 'B'); const c = await folder(backend, 'C');
    const nested = await folder(backend, 'A-child', a.id);
    const moved = await backend.dispatch({ type: 'moveFolder', id: c.id, parentId: null, beforeId: a.id }) as Snapshot;
    expect(moved.folders.filter((f) => f.parentId === null).map((f) => f.name)).toEqual(['C', 'A', 'B']);
    expect(moved.folders.find((f) => f.id === nested.id)?.parentId).toBe(a.id);
    expect(b.deleted).toBe(false);
  });
});

describe('versioned backup', () => {
  it('roundtrips data, previews additive records, and preserves existing records on import', async () => {
    const source = setup(); const f = await folder(source.backend, '旧名字');
    await source.backend.dispatch({ type: 'discover', conversations: [conversation('conv')] });
    await source.backend.dispatch({ type: 'assign', conversationIds: ['conv'], folderId: f.id });
    const backup = await source.backend.dispatch({ type: 'exportBackup' }) as Backup;
    const destination = setup();
    expect(await destination.backend.dispatch({ type: 'previewImport', backup })).toEqual({ folders: 1, conversations: 1, placements: 1, skipped: 0 });
    const imported = await destination.backend.dispatch({ type: 'importBackup', backup }) as Snapshot;
    expect(imported.folders[0].name).toBe('旧名字'); expect(imported.placements[0].conversationId).toBe('conv');
    await destination.backend.dispatch({ type: 'renameFolder', id: f.id, name: '本地新名字' });
    expect(await destination.backend.dispatch({ type: 'previewImport', backup })).toEqual({ folders: 0, conversations: 0, placements: 0, skipped: 3 });
    const again = await destination.backend.dispatch({ type: 'importBackup', backup }) as Snapshot;
    expect(again.folders[0].name).toBe('本地新名字');
    expect(again.settings.syncEnabled).toBe(false);
  });
  it('rejects malformed, unsafe, duplicate, cyclic and unsupported backups atomically', async () => {
    const { backend } = setup(); const f = await folder(backend, '保留');
    const backup = await backend.dispatch({ type: 'exportBackup' }) as Backup;
    const malformed = [
      { ...backup, schemaVersion: 2 },
      { ...backup, folders: [f, f] },
      { ...backup, folders: [{ ...f, parentId: f.id }] },
      { ...backup, folders: [{ ...f, id: '__proto__' }] },
      { ...backup, folders: [{ ...f, id: 'toString' }] },
      { ...backup, conversations: [{ ...conversation('safe'), url: 'https://evil.example/c/safe' }] },
      { ...backup, conversations: [{ ...conversation('safe'), url: 'https://chatgpt.com/c/different' }] },
      JSON.parse('{"schemaVersion":1,"__proto__":{"polluted":true}}'),
    ];
    for (const bad of malformed) await expect(backend.dispatch({ type: 'importBackup', backup: bad })).rejects.toThrow();
    expect((await backend.dispatch({ type: 'getState' }) as Snapshot).folders).toHaveLength(1);
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
  });
  it('accepts custom GPT conversation paths and refuses URL spoofing', async () => {
    const { backend } = setup();
    const valid = { ...conversation('chat-42'), url: 'https://chatgpt.com/g/g-example/c/chat-42' };
    await backend.dispatch({ type: 'discover', conversations: [valid] });
    await expect(backend.dispatch({ type: 'discover', conversations: [{ ...valid, url: 'https://chatgpt.com@evil.example/c/chat-42' }] })).rejects.toThrow();
    expect((await backend.dispatch({ type: 'getState' }) as Snapshot).conversations[0].url).toBe(valid.url);
  });
});

describe('effective hierarchy repair', () => {
  it('normalizes remote cycles and excessive depth deterministically without mutating raw records', () => {
    const revision = { clock: 1, device: 'device' };
    const raw: StoredState['folders'] = {};
    for (const [id, parentId] of [['a', 'b'], ['b', 'a'], ['c', 'b'], ['d', 'c'], ['e', 'missing']] as const) raw[id] = { id, parentId, name: id, order: 0, revision, deleted: false };
    const before = JSON.stringify(raw); const result = normalizedFolders(raw);
    expect(result.find((f) => f.id === 'a')?.parentId).toBeNull();
    expect(result.find((f) => f.id === 'd')?.parentId).toBeNull();
    expect(result.find((f) => f.id === 'e')?.parentId).toBeNull();
    expect(JSON.stringify(raw)).toBe(before);
    expect(normalizedFolders(Object.fromEntries(Object.entries(raw).reverse()))).toEqual(result);
  });
});
