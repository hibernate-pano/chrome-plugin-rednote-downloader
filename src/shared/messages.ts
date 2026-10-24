import type {
  DownloadMode,
  DownloadProgress,
  DownloadTaskItem,
  PackItem,
  Settings,
  TaskSummary,
} from './types';

/** content script → service worker */
export type C2BMessage =
  | { type: 'GET_SETTINGS' }
  | { type: 'START_DOWNLOADS'; taskId: string; items: DownloadTaskItem[] }
  | { type: 'CANCEL_TASK'; taskId: string }
  | { type: 'RETRY_TASK_ITEM'; taskId: string; itemId: string }
  | { type: 'SAVE_SETTINGS'; settings: Partial<Settings> }
  | { type: 'GET_HISTORY' }
  | { type: 'OPEN_OPTIONS' }
  | { type: 'SHOW_DOWNLOADS'; downloadId?: number }
  | { type: 'GET_SESSION_STATS' }
  | { type: 'PING' };

/** service worker → service worker */
export type B2CMessage =
  | { type: 'DOWNLOAD_PROGRESS'; progress: DownloadProgress[] }
  | { type: 'TASK_SUMMARY'; summary: TaskSummary }
  | { type: 'TASK_CLEARED'; taskId: string };

/**
 * service worker → 后台页面（offscreen）
 *
 * 打包这种「长时间跑」的活儿放在后台页面里，而不是 Service Worker：
 * Service Worker 空闲 30 秒就会被浏览器杀掉，几百个文件的活儿根本跑不完；
 * 后台页面没有这个限制。
 */
export type WorkerToOffscreen =
  | {
      type: 'ZIP_START';
      taskId: string;
      items: PackItem[];
      concurrency: number;
      /** 单个包的大小上限（字节） */
      maxZipBytes: number;
      /** 包的名字（不含扩展名） */
      packName: string;
      /** 相对于浏览器下载目录的文件夹（可空） */
      rootFolder: string;
    }
  | { type: 'ZIP_CANCEL'; taskId: string }
  /** 下载完了，把临时的包删掉（省磁盘） */
  | { type: 'ZIP_CLEANUP'; taskId: string; dirName: string; packNames: string[] };

/** 后台页面 → service worker */
export type OffscreenToWorker =
  | {
      type: 'ZIP_ITEM_PROGRESS';
      taskId: string;
      itemId: string;
      received: number;
      total: number;
    }
  | { type: 'ZIP_ITEM_DONE'; taskId: string; itemId: string; bytes: number }
  | { type: 'ZIP_ITEM_FAILED'; taskId: string; itemId: string; error: string }
  /**
   * 包打好了。
   *
   * blob: 地址只能由后台页面生成（Service Worker 里没有 createObjectURL），
   * 而 chrome.downloads 只有 Service Worker 里有 ——
   * 所以后台页面把地址交给 Service Worker，由它发起下载。
   */
  | {
      type: 'ZIP_PACKS_READY';
      taskId: string;
      packs: {
        dirName: string;
        name: string;
        objectUrl: string;
        downloadPath: string;
        bytes: number;
        entries: number;
      }[];
    }
  | { type: 'ZIP_FAILED'; taskId: string; error: string };

export type AnyMessage = C2BMessage | B2CMessage;

export const MSG = {
  GET_SETTINGS: 'GET_SETTINGS',
  START_DOWNLOADS: 'START_DOWNLOADS',
  CANCEL_TASK: 'CANCEL_TASK',
  RETRY_TASK_ITEM: 'RETRY_TASK_ITEM',
  SAVE_SETTINGS: 'SAVE_SETTINGS',
  GET_HISTORY: 'GET_HISTORY',
  OPEN_OPTIONS: 'OPEN_OPTIONS',
  SHOW_DOWNLOADS: 'SHOW_DOWNLOADS',
  GET_SESSION_STATS: 'GET_SESSION_STATS',
  PING: 'PING',
  DOWNLOAD_PROGRESS: 'DOWNLOAD_PROGRESS',
  TASK_SUMMARY: 'TASK_SUMMARY',
  TASK_CLEARED: 'TASK_CLEARED',
} as const;

/**
 * 目录状态的对外描述（设置页、面板都用它）。
 *
 * @deprecated 打包模式不再需要用户自己选目录 —— 包最后还是交给 Chrome 下载。
 */
export interface DirectoryState {
  /** 是否已经选过目录 */
  hasDirectory: boolean;
  /** 目录名（用户可见） */
  name?: string;
  /** 当前授权状态：granted 可直接写；prompt 需要用户再点一次授权 */
  permission?: 'granted' | 'denied' | 'prompt';
  /** 当前下载方式 */
  mode: DownloadMode;
}

export interface HistoryEntry {
  taskId: string;
  startedAt: number;
  finishedAt?: number;
  total: number;
  completed: number;
  failed: number;
  folder?: string;
}
