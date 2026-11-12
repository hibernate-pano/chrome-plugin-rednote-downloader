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
import { packIntoOpfs, removePack, removePackDir } from './pack';

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
  // 目录本身也删掉 —— 一个任务一个目录（pack-<taskId>），
  // 包删完之后留着个空目录也是垃圾，攒多了 OPFS 就没法看了
  if (dirName) await removePackDir(dirName);
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

/**
 * 取消一个任务：临时产物一样都不留。
 *
 * 为什么不能只 abort 打包：
 *   - 打包写到一半被取消，OPFS 目录里会留下**没写完的半成品包**；
 *   - 包已经交付、浏览器正在下载时取消，那个包和它的 blob: 地址就没人管了。
 *
 * 而且删的时机很重要：打包线程可能正拿着文件句柄在写，
 * 这时候把目录删掉，它下一笔又写回来。所以先等它真的停下来，再删。
 */
async function handleCancel(taskId: string): Promise<void> {
  // 等打包线程退出（handleStart 的 finally 会把 taskId 从 running 里删掉）
  for (let i = 0; i < 60 && running.has(taskId); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  await removePackDir(`pack-${taskId}`);
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
    // 取消 = 这个任务的临时产物一样都不留（半成品包、已交付的 blob 地址）
    void handleCancel(message.taskId);
    return false;
  }
  if (message?.type === 'ZIP_CLEANUP') {
    void handleCleanup(message);
    return false;
  }
  return false;
});
