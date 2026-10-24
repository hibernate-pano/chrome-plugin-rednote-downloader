import { MSG, type C2BMessage } from '../shared/messages';
import { shortId } from '../shared/utils';
import {
  attachDownloadListeners,
  cancelTask,
  getHistory,
  getSessionStats,
  getSettings,
  initDownloader,
  retryItem,
  saveSettings,
  startDownloads,
} from './downloader';

/* ------------------------------------------------------------------ */
/* 生命周期                                                            */
/* ------------------------------------------------------------------ */

attachDownloadListeners();
void initDownloader();

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

          case MSG.START_DOWNLOADS:
            await startDownloads(sender.tab?.id, message.taskId, message.items);
            sendResponse({ ok: true });
            break;

          case MSG.CANCEL_TASK:
            await cancelTask(message.taskId);
            sendResponse({ ok: true });
            break;

          case MSG.RETRY_TASK_ITEM:
            await retryItem(message.taskId, message.itemId);
            sendResponse({ ok: true });
            break;

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

/* ------------------------------------------------------------------ */
/* 安装 / 更新                                                        */
/* ------------------------------------------------------------------ */

chrome.runtime.onInstalled.addListener(() => {
  // 扩展更新后重置设置？这里保留用户设置，只做一次校验
  void getSettings();
});

// 供 popup 快速生成任务 id
export { shortId };
