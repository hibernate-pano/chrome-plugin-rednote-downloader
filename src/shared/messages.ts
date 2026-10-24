import type { DownloadProgress, DownloadTaskItem, Settings, TaskSummary } from './types';

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
  PING: 'PING',
  DOWNLOAD_PROGRESS: 'DOWNLOAD_PROGRESS',
  TASK_SUMMARY: 'TASK_SUMMARY',
  TASK_CLEARED: 'TASK_CLEARED',
} as const;

export interface HistoryEntry {
  taskId: string;
  startedAt: number;
  finishedAt?: number;
  total: number;
  completed: number;
  failed: number;
  folder?: string;
}
