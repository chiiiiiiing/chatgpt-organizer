import { newState, type StoredState } from './model';

/** One read/write transaction is the serialization boundary, also across callers. */
export class Database {
  private connection: Promise<IDBDatabase>;
  constructor(name = 'chatgpt-organizer-v1') {
    this.connection = new Promise((resolve, reject) => {
      const request = indexedDB.open(name, 1);
      request.onupgradeneeded = () => request.result.createObjectStore('state');
      request.onerror = () => reject(request.error);
      request.onsuccess = () => { request.result.onversionchange = () => request.result.close(); resolve(request.result); };
    });
  }
  async update<T>(mutator: (state: StoredState) => T): Promise<T> {
    const db = await this.connection;
    return new Promise<T>((resolve, reject) => {
      const transaction = db.transaction('state', 'readwrite');
      const store = transaction.objectStore('state');
      const request = store.get('root');
      let result: T; let thrown: unknown;
      request.onsuccess = () => {
        try {
          const state: StoredState = request.result ?? newState();
          result = mutator(state);
          store.put(state, 'root');
        } catch (error) { thrown = error; transaction.abort(); }
      };
      transaction.oncomplete = () => resolve(result);
      transaction.onabort = transaction.onerror = () => reject(thrown ?? transaction.error ?? new Error('本地数据库写入失败，原数据未改变。'));
    });
  }
  async read(): Promise<StoredState> {
    const db = await this.connection;
    const current = await new Promise<StoredState | undefined>((resolve, reject) => {
      const transaction = db.transaction('state', 'readonly');
      const request = transaction.objectStore('state').get('root');
      request.onsuccess = () => resolve(request.result as StoredState | undefined);
      request.onerror = () => reject(request.error);
    });
    // Only a fresh database needs a write; ordinary UI refreshes must remain read-only.
    return current ?? this.update((state) => structuredClone(state));
  }
  async close(): Promise<void> { (await this.connection).close(); }
}
