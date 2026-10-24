import type { DownloadMode, DownloadProgress, DownloadTaskItem, Settings, TaskSummary } from './types';

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
  /** 选目录窗口 / 设置页 → service worker */
  | { type: 'DIRECTORY_READY'; name: string }
  | { type: 'DIRECTORY_CANCELLED'; taskId?: string }
  | { type: 'USE_BROWSER_DOWNLOAD' }
  | { type: 'CLEAR_DIRECTORY' }
  | { type: 'GET_DIRECTORY_STATE' }
  | { type: 'PING' };

/** service worker → content script */
export type B2CMessage =
  | { type: 'DOWNLOAD_PROGRESS'; progress: DownloadProgress[] }
  | { type: 'TASK_SUMMARY'; summary: TaskSummary }
  | { type: 'TASK_CLEARED'; taskId: string };

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
  DIRECTORY_READY: 'DIRECTORY_READY',
  DIRECTORY_CANCELLED: 'DIRECTORY_CANCELLED',
  USE_BROWSER_DOWNLOAD: 'USE_BROWSER_DOWNLOAD',
  CLEAR_DIRECTORY: 'CLEAR_DIRECTORY',
  GET_DIRECTORY_STATE: 'GET_DIRECTORY_STATE',
  PING: 'PING',
  DOWNLOAD_PROGRESS: 'DOWNLOAD_PROGRESS',
  TASK_SUMMARY: 'TASK_SUMMARY',
  TASK_CLEARED: 'TASK_CLEARED',
} as const;

/** 目录状态的对外描述（选目录窗口、设置页、面板都用它） */
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
