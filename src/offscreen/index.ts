/**
 * 后台页面（offscreen document）。
 *
 * 为什么要有这么一个页面：
 *   1. Service Worker 空闲 30 秒就会被浏览器杀掉。几百个文件的打包
 *      远超 30 秒，放在 Service Worker 里必然中途夭折。
 *      后台页面没有这个限制。
 *   2. blob: 地址只能用 URL.createObjectURL 生成，而 Service Worker 里
 *      没有这个 API —— 必须有一个「像窗口一样」的环境。
 *
 * 它只干两件事：把文件打成 zip，把打好的包变成 blob: 地址交给 Service Worker。
 * 真正发起下载的是 Service Worker —— 后台页面里没有 chrome.downloads。
 */

import type { OffscreenToWorker, WorkerToOffscreen } from '../shared/messages';
import { packIntoOpfs, removePack } from './pack';

/** 正在跑的任务：taskId → 中断控制器 */
const running = new Map<string, AbortController>();

/** 已经交付出去的包：taskId → [{ url, dirName, name }]（等下载完了再删） */
const delivered = new Map<string, { url: string; dirName: string; name: string }[]>();

/** 往 Service Worker 报进度（它再转给页面） */
function report(message: OffscreenToWorker): void {
  void chrome.runtime.sendMessage(message).catch(() => undefined);
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function handleStart(message: Extract<WorkerToOffscreen, { type: 'ZIP_START' }>): Promise<void> {
  const { taskId, items, concurrency, maxZipBytes, packName, rootFolder } = message;

  const controller = new AbortController();
  running.set(taskId, controller);

  try {
    const dirName = `pack-${taskId}`;
    const result = await packIntoOpfs({
      items,
      dirName,
      concurrency,
      maxZipBytes,
      signal: controller.signal,
      onItemProgress: (itemId, received, total) =>
        report({ type: 'ZIP_ITEM_PROGRESS', taskId, itemId, received, total }),
      onItemDone: (itemId, bytes) => report({ type: 'ZIP_ITEM_DONE', taskId, itemId, bytes }),
      onItemFailed: (itemId, error) => report({ type: 'ZIP_ITEM_FAILED', taskId, itemId, error }),
    });

    if (controller.signal.aborted) return;

    // 把每个包变成 blob: 地址，交给 Service Worker 去下载
    const packs: {
      dirName: string;
      name: string;
      objectUrl: string;
      downloadPath: string;
      bytes: number;
      entries: number;
    }[] = [];
    const handles: { url: string; dirName: string; name: string }[] = [];

    for (let i = 0; i < result.packs.length; i += 1) {
      const pack = result.packs[i];
      if (!pack) continue;
      const suffix = result.packs.length > 1 ? `-${i + 1}` : '';
      const fileName = `${packName}${suffix}.zip`;
      const downloadPath = rootFolder ? `${rootFolder}/${fileName}` : fileName;

      const objectUrl = await createPackUrl(dirName, pack.name);
      if (!objectUrl) {
        report({ type: 'ZIP_FAILED', taskId, error: '打包文件读取失败' });
        return;
      }
      handles.push({ url: objectUrl, dirName, name: pack.name });
      packs.push({
        dirName,
        name: pack.name,
        objectUrl,
        downloadPath,
        bytes: pack.bytes,
        entries: pack.entries,
      });
    }

    delivered.set(taskId, handles);
    report({ type: 'ZIP_PACKS_READY', taskId, packs });
  } catch (err) {
    report({ type: 'ZIP_FAILED', taskId, error: errorText(err) });
  } finally {
    running.delete(taskId);
  }
}

/** 把 OPFS 里的包变成 blob: 地址 */
async function createPackUrl(dirName: string, packName: string): Promise<string | null> {
  try {
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle(dirName);
    const handle = await dir.getFileHandle(packName);
    const file = await handle.getFile();
    return URL.createObjectURL(file);
  } catch {
    return null;
  }
}

/** 下载完了：把临时的包和地址都清掉 */
async function handleCleanup(message: Extract<WorkerToOffscreen, { type: 'ZIP_CLEANUP' }>): Promise<void> {
  const { taskId, dirName, packNames } = message;
  for (const name of packNames) await removePack(dirName, name);
  const handles = delivered.get(taskId) ?? [];
  for (const handle of handles) {
    try {
      URL.revokeObjectURL(handle.url);
    } catch {
      /* ignore */
    }
  }
  delivered.delete(taskId);
}

chrome.runtime.onMessage.addListener((message: WorkerToOffscreen, _sender, sendResponse) => {
  if (message?.type === 'ZIP_START') {
    // 立刻回话：打包要好一会儿，不能让 Service Worker 在这儿干等
    sendResponse({ ok: true });
    void handleStart(message);
    return false;
  }
  if (message?.type === 'ZIP_CANCEL') {
    running.get(message.taskId)?.abort();
    return false;
  }
  if (message?.type === 'ZIP_CLEANUP') {
    void handleCleanup(message);
    return false;
  }
  return false;
});
