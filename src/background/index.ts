import { MSG, type C2BMessage, type DirectoryState } from '../shared/messages';
import { shortId } from '../shared/utils';
import {
  attachDownloadListeners,
  cancelTask,
  getHistory,
  getSessionStats,
  getSettings,
  getWaitingTaskId,
  initDownloader,
  onDirectoryCancelled,
  onDirectoryReady,
  onUseBrowserDownload,
  retryItem,
  saveSettings,
  startDownloads,
  watchSettings,
} from './downloader';
import { clearRootHandle, getRootHandle, queryPermission } from '../shared/fs-store';

/* ------------------------------------------------------------------ */
/* 生命周期                                                            */
/* ------------------------------------------------------------------ */

attachDownloadListeners();
watchSettings();
void initDownloader();

/* ------------------------------------------------------------------ */
/* 选目录窗口                                                          */
/* ------------------------------------------------------------------ */

/**
 * 弹出选目录的小窗口。
 *
 * 为什么必须是扩展自己的页面：
 * 内容脚本（isolated world）里 showDirectoryPicker 拿到的句柄绑定的是
 * 「小红书这个站点」的 origin —— 存不进扩展的 IndexedDB，也交不了 Service Worker。
 * 只有扩展自己的页面拿到的句柄才绑定扩展的 origin，Service Worker 才能接着写。
 *
 * 已经开着一个就把它拉到前面，不重复弹窗。
 */
let pickerWindowId: number | null = null;

async function openPickerWindow(taskId?: string): Promise<void> {
  if (pickerWindowId !== null) {
    try {
      await chrome.windows.update(pickerWindowId, { focused: true });
      return;
    } catch {
      pickerWindowId = null; // 窗口已经被关了
    }
  }
  try {
    const win = await chrome.windows.create({
      url: chrome.runtime.getURL(
        taskId ? `picker.html?task=${encodeURIComponent(taskId)}` : 'picker.html',
      ),
      type: 'popup',
      width: 440,
      height: 340,
      focused: true,
    });
    pickerWindowId = win.id ?? null;
  } catch {
    pickerWindowId = null;
  }
}

chrome.windows.onRemoved.addListener((windowId) => {
  if (windowId === pickerWindowId) pickerWindowId = null;
});

/* ------------------------------------------------------------------ */
/* 消息路由                                                            */
/* ------------------------------------------------------------------ */

chrome.runtime.onMessage.addListener(
  (message: C2BMessage, sender, sendResponse) => {
    void (async () => {
      try {
        switch (message.type) {
          case MSG.GET_SETTINGS:
            sendResponse({ ok: true, settings: await getSettings() });
            break;

          case MSG.SAVE_SETTINGS:
            sendResponse({ ok: true, settings: await saveSettings(message.settings) });
            break;

          case MSG.START_DOWNLOADS: {
            const result = await startDownloads(sender.tab?.id, message.taskId, message.items);
            if (result.waiting) await openPickerWindow(message.taskId);
            sendResponse({ ok: true, waiting: result.waiting });
            break;
          }

          case MSG.CANCEL_TASK:
            await cancelTask(message.taskId);
            sendResponse({ ok: true });
            break;

          case MSG.RETRY_TASK_ITEM: {
            const result = await retryItem(message.taskId, message.itemId);
            if (result.waiting) await openPickerWindow(message.taskId);
            sendResponse({ ok: true, waiting: result.waiting });
            break;
          }

          case MSG.GET_HISTORY:
            sendResponse({ ok: true, history: await getHistory() });
            break;

          case MSG.GET_SESSION_STATS:
            sendResponse({ ok: true, stats: await getSessionStats() });
            break;

          case MSG.OPEN_OPTIONS:
            await chrome.runtime.openOptionsPage();
            sendResponse({ ok: true });
            break;

          case MSG.SHOW_DOWNLOADS: {
            const items = await chrome.downloads.search({ limit: 1, orderBy: ['-startTime'] });
            const target = message.downloadId ?? items[0]?.id;
            if (target !== undefined) await chrome.downloads.show(target);
            sendResponse({ ok: true });
            break;
          }

          /* ---------------- 保存目录 ---------------- */

          case MSG.DIRECTORY_READY:
            // 选目录窗口已经存好句柄了，放行挂起的任务
            await onDirectoryReady();
            sendResponse({ ok: true });
            break;

          case MSG.DIRECTORY_CANCELLED:
            await onDirectoryCancelled(message.taskId);
            // 这个窗口正在关，不能再复用它 ——
            // 别的标签页可能也在等目录，得给它们再弹一个
            pickerWindowId = null;
            const stillWaiting = getWaitingTaskId();
            if (stillWaiting) await openPickerWindow(stillWaiting);
            sendResponse({ ok: true });
            break;

          case MSG.USE_BROWSER_DOWNLOAD:
            await onUseBrowserDownload();
            sendResponse({ ok: true });
            break;

          case MSG.CLEAR_DIRECTORY:
            await clearRootHandle();
            sendResponse({ ok: true });
            break;

          case MSG.GET_DIRECTORY_STATE: {
            const state: DirectoryState = await getDirectoryState();
            sendResponse({ ok: true, state });
            break;
          }

          case MSG.PING:
            sendResponse({ ok: true, at: Date.now() });
            break;

          default:
            sendResponse({ ok: false, error: '未知消息' });
        }
      } catch (err) {
        sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    })();
    return true; // 异步响应
  },
);

/** 当前目录状态：设了没、叫什么、授权还在不在 */
export async function getDirectoryState(): Promise<DirectoryState> {
  const handle = await getRootHandle();
  const settings = await getSettings();
  return {
    hasDirectory: Boolean(handle),
    name: handle?.name,
    permission: await queryPermission(handle, 'readwrite'),
    mode: settings.downloadMode,
  };
}

/* ------------------------------------------------------------------ */
/* 安装 / 更新                                                        */
/* ------------------------------------------------------------------ */

chrome.runtime.onInstalled.addListener(() => {
  // 扩展更新后重置设置？这里保留用户设置，只做一次校验
  void getSettings();
});

// 供 popup 快速生成任务 id
export { shortId };
