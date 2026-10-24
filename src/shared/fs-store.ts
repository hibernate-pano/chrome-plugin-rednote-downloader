/**
 * 保存目录句柄的存取。
 *
 * 句柄（FileSystemDirectoryHandle）不能塞进 chrome.storage —— 那里只能放 JSON。
 * 但它能进 IndexedDB：IndexedDB 用的是结构化克隆，句柄会被完整保留下来。
 *
 * 为什么要绕这一圈：
 *   - 内容脚本（isolated world）里 showDirectoryPicker 拿到的句柄，
 *     绑定的是「小红书这个站点」的 origin —— 存不进扩展，也交不了 Service Worker。
 *   - 只有扩展自己的页面（选目录窗口、设置页）拿到的句柄才绑定扩展的 origin，
 *     Service Worker 才能从 IndexedDB 里把它读出来接着写。
 *
 * 实测：句柄经 IndexedDB 中转后，Service Worker 里 createWritable() 写入正常。
 */

const DB_NAME = 'rednote-fs';
const DB_VERSION = 1;
const STORE = 'handles';
const KEY = 'root';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('打开 IndexedDB 失败'));
  });
}

async function withStore<T>(
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const db = await openDb();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const req = fn(tx.objectStore(STORE));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error ?? new Error('IndexedDB 操作失败'));
    });
  } finally {
    db.close();
  }
}

/** 读出已保存的根目录句柄，没有则返回 null */
export async function getRootHandle(): Promise<FileSystemDirectoryHandle | null> {
  try {
    const handle = await withStore<FileSystemDirectoryHandle | undefined>('readonly', (store) =>
      store.get(KEY),
    );
    return handle ?? null;
  } catch {
    return null;
  }
}

/** 保存根目录句柄 */
export async function setRootHandle(handle: FileSystemDirectoryHandle): Promise<void> {
  await withStore('readwrite', (store) => store.put(handle, KEY));
}

/** 忘掉根目录句柄（用户要换目录时用） */
export async function clearRootHandle(): Promise<void> {
  try {
    await withStore('readwrite', (store) => store.delete(KEY));
  } catch {
    /* ignore */
  }
}

/**
 * 查目录的授权状态。
 *
 * granted：可以直接写。
 * prompt：句柄还在，但用户重新打开浏览器后要再授权一次 ——
 *         重新授权必须由用户手势触发（requestPermission），所以得在页面里做。
 */
export async function queryPermission(
  handle: FileSystemDirectoryHandle | null,
  mode: 'read' | 'readwrite' = 'readwrite',
): Promise<'granted' | 'denied' | 'prompt'> {
  if (!handle) return 'prompt';
  try {
    const state = await handle.queryPermission({ mode });
    return state as 'granted' | 'denied' | 'prompt';
  } catch {
    return 'prompt';
  }
}

/**
 * 拿一个「现在就能写」的目录句柄。
 *
 * 授权还在就直接用；授权没了就返回 null ——
 * 上层负责弹选目录窗口让用户重新授权，而不是在这里偷偷申请。
 */
export async function getWritableRoot(): Promise<FileSystemDirectoryHandle | null> {
  const handle = await getRootHandle();
  if (!handle) return null;
  const permission = await queryPermission(handle, 'readwrite');
  if (permission !== 'granted') return null;
  return handle;
}
