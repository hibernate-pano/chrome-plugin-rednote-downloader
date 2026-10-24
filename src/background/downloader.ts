import type {
  DownloadProgress,
  DownloadState,
  DownloadTaskItem,
  DownloadTaskSnapshot,
  Settings,
  TaskSummary,
} from '../shared/types';
import { DEFAULT_SETTINGS } from '../shared/types';
import type { HistoryEntry } from '../shared/messages';

const STATE_KEY = 'rednote.download.tasks';
const STATS_KEY = 'rednote.session.stats';
const SETTINGS_KEY = 'rednote.settings';
const HISTORY_KEY = 'rednote.history';

/** 进度轮询间隔（毫秒） */
const POLL_INTERVAL = 450;

/**
 * 可以自动重试的中断原因 —— 网络/服务端的瞬时故障。
 * 竞品最常见的槽点就是「10 次下载 5 次无限转圈」，这里靠自动重试兜住。
 */
const RETRYABLE_ERRORS = new Set([
  'NETWORK_FAILED',
  'NETWORK_TIMEOUT',
  'NETWORK_DISCONNECTED',
  'SERVER_FAILED',
  'SERVER_UNREACHABLE',
  'FILE_TRANSIENT_ERROR',
]);

/** 自动重试次数上限 */
const MAX_AUTO_RETRY = 2;

interface TaskRecord {
  taskId: string;
  tabId?: number;
  items: DownloadProgress[];
  queue: string[];
  running: Map<number, string>;
  summary: TaskSummary;
  /** itemId → 原始下载参数 */
  sources: Map<string, DownloadTaskItem>;
  /** 已经重试过的项，避免无限重试 */
  retried: Set<string>;
  /** itemId → 已经自动重试的次数 */
  attempts: Map<string, number>;
  /** 上一次采样，用于算速度 */
  lastTick: Map<string, { at: number; bytes: number }>;
}

const tasks = new Map<string, TaskRecord>();
let pollTimer: ReturnType<typeof setInterval> | null = null;
let lastBroadcast = 0;

/* ------------------------------------------------------------------ */
/* 持久化                                                              */
/* ------------------------------------------------------------------ */

async function persist(): Promise<void> {
  const snapshot = [];
  for (const task of tasks.values()) {
    snapshot.push({
      ...task,
      running: Array.from(task.running.entries()),
      sources: Array.from(task.sources.entries()),
      retried: Array.from(task.retried),
      attempts: Array.from(task.attempts.entries()),
      lastTick: Array.from(task.lastTick.entries()),
    });
  }
  await chrome.storage.session.set({ [STATE_KEY]: snapshot });
}

async function restore(): Promise<void> {
  try {
    const raw = await chrome.storage.session.get(STATE_KEY);
    const list = raw?.[STATE_KEY];
    if (!Array.isArray(list)) return;
    for (const item of list) {
      const record: TaskRecord = {
        ...item,
        running: new Map(item.running ?? []),
        sources: new Map(item.sources ?? []),
        retried: new Set(item.retried ?? []),
        attempts: new Map(item.attempts ?? []),
        lastTick: new Map(item.lastTick ?? []),
      };
      tasks.set(record.taskId, record);
    }
  } catch {
    /* ignore */
  }
}

export async function getSettings(): Promise<Settings> {
  try {
    const raw = await chrome.storage.local.get(SETTINGS_KEY);
    const stored = (raw?.[SETTINGS_KEY] ?? {}) as Partial<Settings> & {
      folderByNote?: boolean;
    };
    // 旧版本只有「按笔记建子文件夹」这一个开关。迁移成新的保存结构，
    // 别让老用户升级之后目录结构突然变了。
    const migrated: Partial<Settings> = { ...stored };
    if (!migrated.saveStructure) {
      migrated.saveStructure = stored.folderByNote === false ? 'flat' : 'perNote';
    }
    delete (migrated as { folderByNote?: boolean }).folderByNote;
    return { ...DEFAULT_SETTINGS, ...migrated };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export async function saveSettings(patch: Partial<Settings>): Promise<Settings> {
  const current = await getSettings();
  const next = { ...current, ...patch };
  await chrome.storage.local.set({ [SETTINGS_KEY]: next });
  return next;
}

export interface SessionStats {
  completed: number;
  bytes: number;
}

export async function getSessionStats(): Promise<SessionStats> {
  try {
    const raw = await chrome.storage.session.get(STATS_KEY);
    const stats = raw?.[STATS_KEY];
    return {
      completed: Number(stats?.completed ?? 0),
      bytes: Number(stats?.bytes ?? 0),
    };
  } catch {
    return { completed: 0, bytes: 0 };
  }
}

async function bumpSessionStats(bytes: number): Promise<void> {
  const stats = await getSessionStats();
  await chrome.storage.session.set({
    [STATS_KEY]: { completed: stats.completed + 1, bytes: stats.bytes + Math.max(0, bytes) },
  });
}

export async function getHistory(): Promise<HistoryEntry[]> {
  try {
    const raw = await chrome.storage.local.get(HISTORY_KEY);
    const list = raw?.[HISTORY_KEY];
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

async function pushHistory(entry: HistoryEntry): Promise<void> {
  const history = await getHistory();
  history.unshift(entry);
  await chrome.storage.local.set({ [HISTORY_KEY]: history.slice(0, 50) });
}

/* ------------------------------------------------------------------ */
/* 广播                                                                */
/* ------------------------------------------------------------------ */

async function broadcast(record: TaskRecord, force = false): Promise<void> {
  if (record.tabId === undefined) return;
  const now = Date.now();
  if (!force && now - lastBroadcast < 200) return;
  lastBroadcast = now;
  try {
    await chrome.tabs.sendMessage(record.tabId, {
      type: 'DOWNLOAD_PROGRESS',
      progress: record.items,
    });
  } catch {
    /* 页面可能已关闭 */
  }
}

/* ------------------------------------------------------------------ */
/* 队列                                                                */
/* ------------------------------------------------------------------ */

export async function startDownloads(
  tabId: number | undefined,
  taskId: string,
  items: DownloadTaskItem[],
): Promise<void> {
  const record: TaskRecord = {
    taskId,
    tabId,
    items: items.map((item) => ({
      taskId,
      itemId: item.itemId,
      state: 'queued' as DownloadState,
      bytesReceived: 0,
      totalBytes: item.size ?? -1,
      filename: item.filename,
    })),
    queue: items.map((item) => item.itemId),
    running: new Map(),
    sources: new Map(items.map((item) => [item.itemId, item])),
    summary: {
      taskId,
      total: items.length,
      completed: 0,
      failed: 0,
      startedAt: Date.now(),
    },
    retried: new Set(),
    attempts: new Map(),
    lastTick: new Map(),
  };

  tasks.set(taskId, record);
  await persist();
  await broadcast(record, true);
  void pump(record);
}

async function pump(record: TaskRecord): Promise<void> {
  const settings = await getSettings();
  const limit = Math.max(1, Math.min(8, settings.concurrency));

  while (record.running.size < limit && record.queue.length > 0) {
    const itemId = record.queue.shift()!;
    const item = record.items.find((i) => i.itemId === itemId);
    if (!item) continue;

    const source = record.sources.get(itemId);
    if (!source) {
      item.state = 'failed';
      item.error = '任务数据丢失';
      record.summary.failed += 1;
      continue;
    }

    try {
      const downloadId = await chrome.downloads.download({
        url: source.url,
        filename: source.filename,
        conflictAction: 'uniquify',
        saveAs: false,
      });
      item.downloadId = downloadId;
      item.state = 'downloading';
      record.running.set(downloadId, itemId);
    } catch (err) {
      item.state = 'failed';
      item.error = err instanceof Error ? err.message : String(err);
      record.summary.failed += 1;
    }
  }

  ensurePolling();
  await persist();
  await broadcast(record, true);
  await checkFinished(record);
}

/* ------------------------------------------------------------------ */
/* 进度轮询                                                            */
/* ------------------------------------------------------------------ */

/**
 * chrome.downloads.onChanged 的 delta 里没有 bytesReceived，
 * 必须用 chrome.downloads.search 拿实时进度。
 */
async function poll(): Promise<void> {
  const active: Array<{ record: TaskRecord; downloadId: number; itemId: string }> = [];
  for (const record of tasks.values()) {
    for (const [downloadId, itemId] of record.running.entries()) {
      active.push({ record, downloadId, itemId });
    }
  }
  if (active.length === 0) return;

  let items: chrome.downloads.DownloadItem[] = [];
  try {
    const results = await Promise.all(
      active.map((a) => chrome.downloads.search({ id: a.downloadId }).catch(() => [])),
    );
    items = results.flat();
  } catch {
    return;
  }

  const now = Date.now();
  for (const info of items) {
    const entry = active.find((a) => a.downloadId === info.id);
    if (!entry) continue;
    const item = entry.record.items.find((i) => i.itemId === entry.itemId);
    if (!item) continue;

    const received = info.bytesReceived ?? item.bytesReceived;
    const total = info.totalBytes && info.totalBytes > 0 ? info.totalBytes : item.totalBytes;

    const prev = entry.record.lastTick.get(entry.itemId) ?? { at: now, bytes: received };
    const dt = (now - prev.at) / 1000;
    if (dt >= 0.4) {
      item.speed = Math.max(0, (received - prev.bytes) / dt);
      entry.record.lastTick.set(entry.itemId, { at: now, bytes: received });
    }

    item.bytesReceived = received;
    if (total !== item.totalBytes) item.totalBytes = total;
    if (info.filename) item.filename = info.filename;

    if (info.state === 'complete') {
      // 浏览器说完成了但文件是 0 字节 —— 这种情况必须当失败，
      // 否则用户以为下好了，硬盘上却什么都没有
      if (info.fileSize === 0) {
        entry.record.running.delete(info.id);
        item.state = 'failed';
        item.error = '下载完成但文件为空，已标记为失败';
        entry.record.summary.failed += 1;
        void persist();
        void broadcast(entry.record, true);
        void pump(entry.record);
        void checkFinished(entry.record);
        continue;
      }
      item.state = 'completed';
      item.bytesReceived = info.bytesReceived ?? received;
      item.totalBytes = info.totalBytes && info.totalBytes > 0 ? info.totalBytes : item.totalBytes;
      entry.record.running.delete(info.id);
      entry.record.summary.completed += 1;
      void bumpSessionStats(info.bytesReceived ?? 0);
      void persist();
      void broadcast(entry.record, true);
      void pump(entry.record);
      void checkFinished(entry.record);
    } else if (info.state === 'interrupted') {
      entry.record.running.delete(info.id);
      const error = info.error ?? '下载中断';
      if (error === 'USER_CANCELED') {
        item.state = 'cancelled';
      } else {
        const attempts = (entry.record.attempts.get(entry.itemId) ?? 0) + 1;
        if (RETRYABLE_ERRORS.has(error) && attempts <= MAX_AUTO_RETRY) {
          // 瞬时故障：退避后自动重试，不让用户干等
          entry.record.attempts.set(entry.itemId, attempts);
          item.state = 'retrying';
          item.error = `${error} · 正在第 ${attempts} 次重试`;
          item.downloadId = undefined;
          item.bytesReceived = 0;
          entry.record.queue.push(entry.itemId);
          void persist();
          void broadcast(entry.record, true);
          scheduleRetry(entry.record, 1000 * 2 ** (attempts - 1));
          continue;
        }
        item.state = 'failed';
        item.error = error;
        entry.record.summary.failed += 1;
      }
      void persist();
      void broadcast(entry.record, true);
      void pump(entry.record);
      void checkFinished(entry.record);
    }
  }
}

/** 退避后重新入队（Service Worker 被杀也没关系，状态在 storage.session 里） */
function scheduleRetry(record: TaskRecord, delayMs: number): void {
  const timer = setTimeout(() => {
    void pump(record);
  }, delayMs);
  // 同上：Node 下不让定时器吊住进程
  (timer as unknown as { unref?: () => void })?.unref?.();
}

function ensurePolling(): void {
  const hasActive = [...tasks.values()].some((t) => t.running.size > 0 || t.queue.length > 0);
  if (!hasActive) {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
    return;
  }
  if (pollTimer) return;
  pollTimer = setInterval(() => void poll(), POLL_INTERVAL);
  // Node 下（单元测试）定时器会吊住进程；浏览器里 setInterval 返回数字，没有这方法
  (pollTimer as unknown as { unref?: () => void })?.unref?.();
}

/* ------------------------------------------------------------------ */
/* chrome.downloads 事件                                               */
/* ------------------------------------------------------------------ */

export function attachDownloadListeners(): void {
  chrome.downloads.onChanged.addListener((delta) => {
    // 状态变化由轮询里的 downloads.search 统一处理，这里只做即时唤醒
    void poll();
  });
}

/* ------------------------------------------------------------------ */
/* 收尾                                                                */
/* ------------------------------------------------------------------ */

async function checkFinished(record: TaskRecord): Promise<void> {
  if (record.running.size > 0 || record.queue.length > 0) return;
  const allDone = record.items.every(
    (i) => i.state === 'completed' || i.state === 'failed' || i.state === 'cancelled',
  );
  if (!allDone) return;

  record.summary.finishedAt = Date.now();
  await pushHistory({
    taskId: record.taskId,
    startedAt: record.summary.startedAt,
    finishedAt: record.summary.finishedAt,
    total: record.summary.total,
    completed: record.summary.completed,
    failed: record.summary.failed,
  });
  await persist();
  await broadcast(record, true);
  ensurePolling();
  if (record.tabId !== undefined) {
    try {
      await chrome.tabs.sendMessage(record.tabId, { type: 'TASK_SUMMARY', summary: record.summary });
    } catch {
      /* ignore */
    }
  }
}

/* ------------------------------------------------------------------ */
/* 对外 API                                                            */
/* ------------------------------------------------------------------ */

export async function cancelTask(taskId: string): Promise<void> {
  const record = tasks.get(taskId);
  if (!record) return;
  for (const downloadId of record.running.keys()) {
    await chrome.downloads.cancel(downloadId).catch(() => undefined);
  }
  record.queue = [];
  record.items.forEach((item) => {
    if (item.state === 'queued') item.state = 'cancelled';
  });
  await persist();
  await broadcast(record, true);
  await checkFinished(record);
}

/** 重试单个失败的下载项 */
export async function retryItem(taskId: string, itemId: string): Promise<void> {
  const record = tasks.get(taskId);
  if (!record) return;
  const item = record.items.find((i) => i.itemId === itemId);
  if (!item || item.state === 'downloading' || item.state === 'completed') return;

  const source = record.sources.get(itemId);
  if (!source) return;

  item.state = 'queued';
  item.bytesReceived = 0;
  item.error = undefined;
  item.downloadId = undefined;
  item.totalBytes = source.size ?? -1;
  record.summary.failed = Math.max(0, record.summary.failed - 1);
  record.queue.push(itemId);
  await persist();
  await broadcast(record, true);
  await pump(record);
}

export function getTaskSnapshot(taskId: string): DownloadTaskSnapshot | undefined {
  const record = tasks.get(taskId);
  if (!record) return undefined;
  return { taskId, items: record.items, summary: record.summary };
}

/**
 * Service Worker 被 Chrome 杀掉再拉起后，对账在途下载。
 *
 * MV3 的 SW 空闲 30 秒就会被终止，轮询定时器随之消失；
 * 状态本身存在 storage.session 里所以不会丢，但「浏览器那边还认不认这个下载」
 * 必须重新问一次 —— 查不到的（比如用户清了下载历史）要标失败，
 * 否则那一项会永远卡在「下载中」，进度条一直转。
 */
async function reconcile(record: TaskRecord): Promise<void> {
  if (record.running.size === 0) return;

  const entries = Array.from(record.running.entries());
  const results = await Promise.all(
    entries.map(([downloadId]) => chrome.downloads.search({ id: downloadId }).catch(() => [] as chrome.downloads.DownloadItem[])),
  );

  for (let i = 0; i < entries.length; i += 1) {
    const [downloadId, itemId] = entries[i]!;
    const found = results[i] ?? [];
    const info = found[0];
    if (info) continue; // 浏览器还认得，交给 poll 继续跟

    const item = record.items.find((x) => x.itemId === itemId);
    record.running.delete(downloadId);
    if (item && item.state !== 'completed') {
      item.state = 'failed';
      item.error = '下载任务已丢失（可能被浏览器清理），请重试';
      record.summary.failed += 1;
    }
  }
}

/** 启动时恢复未完成的任务 */
export async function initDownloader(): Promise<void> {
  await restore();
  for (const record of tasks.values()) {
    if (record.running.size === 0 && record.queue.length === 0) continue;
    await reconcile(record);
    void pump(record);
  }
  ensurePolling();
}
