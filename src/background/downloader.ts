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

/**
 * 进度刷新节拍（毫秒）。
 *
 * 一次查询就能覆盖所有在跑的下载，所以这个节拍只跟「进度要多新鲜」有关，
 * 跟并发数、文件数都无关 —— 之前是每个在跑的下载各查一次，
 * 于是查询量 = 事件数 × 并发数，几十个文件就能把浏览器拖慢。
 */
const TICK_INTERVAL = 300;

/**
 * 两次刷新之间的最小间隔。
 *
 * 下载事件是密集的（每个文件至少 filename + state 两条），
 * 不合并的话每个事件都会打一次 chrome.downloads.search。
 */
const MIN_TICK_GAP = 250;

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
  /** itemId → 已经自动重试的次数 */
  attempts: Map<string, number>;
  /** 上一次采样，用于算速度 */
  lastTick: Map<string, { at: number; bytes: number }>;
  /** 变化过的条目：广播只发这些，页面也只需要补这些 */
  dirty: Set<string>;
  /** 上次广播时间，用来节流 */
  lastBroadcastAt: number;
  /** 上次全量同步时间：页面刷新后靠它把进度补齐 */
  lastFullSyncAt: number;
}

const tasks = new Map<string, TaskRecord>();

/** 下一次刷新的定时器（事件与节拍共用，天然合并） */
let tickTimer: ReturnType<typeof setTimeout> | null = null;
/** 兜底节拍：下载期间没有事件时，靠它刷新进度条 */
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
/** 上一次刷新的时间，用来算最小间隔 */
let lastTickAt = 0;
/** 刷新进行中：防止两个刷新同时结算同一个下载（会把完成数数重） */
let ticking = false;

/** 设置缓存：pump 每完成一个文件就会读一次设置，没必要每次都走存储 */
let settingsCache: Settings | null = null;

/** 本次会话的下载统计：内存里累加，落盘合并到任务快照那一次 */
const statsCache = { completed: 0, bytes: 0 };
let statsLoaded = false;

/* ------------------------------------------------------------------ */
/* 持久化                                                              */
/* ------------------------------------------------------------------ */

/** 落盘节流：下载期间状态变得很勤，全量写会把 storage 的写配额打爆 */
const PERSIST_INTERVAL = 500;

/** 多久补一次全量进度（页面刷新后靠它把进度补齐） */
const FULL_SYNC_INTERVAL = 5000;
let persistTimer: ReturnType<typeof setTimeout> | null = null;
let persistPending = false;

/** 立刻落盘 */
async function persist(): Promise<void> {
  const snapshot = [];
  for (const task of tasks.values()) {
    snapshot.push({
      ...task,
      running: Array.from(task.running.entries()),
      // 只留重启后真正用得上的字段：url / 文件名 / 大小。
      // 备注、作者这些纯展示字段没必要跟着每次落盘走。
      sources: Array.from(task.sources.entries()).map(([itemId, src]) => [
        itemId,
        { itemId: src.itemId, url: src.url, filename: src.filename, size: src.size, kind: src.kind },
      ]),
      attempts: Array.from(task.attempts.entries()),
      lastTick: Array.from(task.lastTick.entries()),
      dirty: Array.from(task.dirty),
    });
  }
  try {
    await chrome.storage.session.set({
      [STATE_KEY]: snapshot,
      [STATS_KEY]: { completed: statsCache.completed, bytes: statsCache.bytes },
    });
  } catch {
    /* 配额爆了也不能让下载停下来 */
  }
}

/**
 * 节流落盘。
 *
 * 写次数是有配额的（每分钟 120 次），一个批次几十上百个文件，
 * 每变一次状态就写一次会直接写爆配额 —— 配额一爆，快照就停在旧版本，
 * Service Worker 被杀之后恢复出来的状态是错的。
 */
function schedulePersist(): void {
  persistPending = true;
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    if (!persistPending) return;
    persistPending = false;
    void persist();
  }, PERSIST_INTERVAL);
  (persistTimer as unknown as { unref?: () => void })?.unref?.();
}

async function restore(): Promise<void> {
  try {
    const raw = await chrome.storage.session.get(STATE_KEY);
    const list = raw?.[STATE_KEY];
    if (Array.isArray(list)) {
      for (const item of list) {
        const record: TaskRecord = {
          ...item,
          running: new Map(item.running ?? []),
          sources: new Map(item.sources ?? []),
          attempts: new Map(item.attempts ?? []),
          lastTick: new Map(item.lastTick ?? []),
          dirty: new Set(item.dirty ?? []),
          lastBroadcastAt: 0,
          lastFullSyncAt: 0,
        };
        tasks.set(record.taskId, record);
      }
    }
    const stats = (await chrome.storage.session.get(STATS_KEY))?.[STATS_KEY];
    statsCache.completed = Number(stats?.completed ?? 0);
    statsCache.bytes = Number(stats?.bytes ?? 0);
    statsLoaded = true;
  } catch {
    /* ignore */
  }
}

/* ------------------------------------------------------------------ */
/* 设置                                                                */
/* ------------------------------------------------------------------ */

export async function getSettings(): Promise<Settings> {
  if (settingsCache) return settingsCache;
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
    settingsCache = { ...DEFAULT_SETTINGS, ...migrated };
    return settingsCache;
  } catch {
    settingsCache = { ...DEFAULT_SETTINGS };
    return settingsCache;
  }
}

export async function saveSettings(patch: Partial<Settings>): Promise<Settings> {
  const current = await getSettings();
  const next = { ...current, ...patch };
  await chrome.storage.local.set({ [SETTINGS_KEY]: next });
  settingsCache = next;
  return next;
}

/** 设置页可能直接在 storage.local 上改，缓存得跟着失效 */
export function watchSettings(): void {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (SETTINGS_KEY in changes) settingsCache = null;
  });
}

/* ------------------------------------------------------------------ */
/* 会话统计                                                            */
/* ------------------------------------------------------------------ */

export interface SessionStats {
  completed: number;
  bytes: number;
}

export async function getSessionStats(): Promise<SessionStats> {
  if (!statsLoaded) {
    try {
      const stats = (await chrome.storage.session.get(STATS_KEY))?.[STATS_KEY];
      statsCache.completed = Number(stats?.completed ?? 0);
      statsCache.bytes = Number(stats?.bytes ?? 0);
      statsLoaded = true;
    } catch {
      /* ignore */
    }
  }
  return { completed: statsCache.completed, bytes: statsCache.bytes };
}

function bumpSessionStats(bytes: number): void {
  statsCache.completed += 1;
  statsCache.bytes += Math.max(0, bytes);
}

/* ------------------------------------------------------------------ */
/* 历史                                                                */
/* ------------------------------------------------------------------ */

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

/**
 * 把变化告诉页面。
 *
 * 只发变化的那几条：之前每次都发全量，几十个文件时每条消息都是几十 KB，
 * 而且页面每收一条就把整个面板重画一遍。
 */
async function broadcast(record: TaskRecord, force = false): Promise<void> {
  if (record.tabId === undefined) return;
  const now = Date.now();
  if (!force && now - record.lastBroadcastAt < 200) return;
  // 平时只发变化的那几条；但每隔几秒补一次全量 ——
  // 用户在下载途中刷新了页面的话，页面得能把进度补齐
  const full = force || now - record.lastFullSyncAt >= FULL_SYNC_INTERVAL;
  const items = full
    ? record.items
    : record.items.filter((i) => record.dirty.has(i.itemId));
  if (items.length === 0) return;
  record.lastBroadcastAt = now;
  if (full) record.lastFullSyncAt = now;
  record.dirty.clear();
  try {
    await chrome.tabs.sendMessage(record.tabId, {
      type: 'DOWNLOAD_PROGRESS',
      progress: items,
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
    attempts: new Map(),
    lastTick: new Map(),
    dirty: new Set(items.map((item) => item.itemId)),
    lastBroadcastAt: 0,
    lastFullSyncAt: 0,
  };

  tasks.set(taskId, record);
  // 先把完整清单给页面，再启动下载 ——
  // 页面得先知道一共要下多少个，进度才有分母
  await broadcast(record, true);
  await pump(record);
  // 在途下载的 id 记在 running 里，Service Worker 被杀之后要靠它对账，
  // 所以这里必须立刻落盘一次，不能等节流
  await persist();
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
      record.dirty.add(itemId);
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
      record.dirty.add(itemId);
    } catch (err) {
      item.state = 'failed';
      item.error = err instanceof Error ? err.message : String(err);
      record.summary.failed += 1;
      record.dirty.add(itemId);
    }
  }

  ensureHeartbeat();
  schedulePersist();
  await broadcast(record);
  await checkFinished(record);
}

/* ------------------------------------------------------------------ */
/* 进度刷新                                                            */
/* ------------------------------------------------------------------ */

/**
 * 一次查回所有在跑的下载。
 *
 * chrome.downloads.search 的 id 字段不接受数组（传数组直接抛 TypeError），
 * 所以这里用「最近 N 条 + 按需兜底」：批量下载总是最近启动的那批，
 * 正常都落在最近 N 条里；万一用户同时在下载别的东西把我们挤出去了，
 * 再按 id 单独补查那几条。
 */
async function fetchRunning(
  active: Array<{ downloadId: number }>,
): Promise<Map<number, chrome.downloads.DownloadItem>> {
  const limit = Math.max(20, active.length * 4 + 10);
  const map = new Map<number, chrome.downloads.DownloadItem>();
  try {
    const list = await chrome.downloads.search({ limit, orderBy: ['-startTime'] });
    for (const info of list) map.set(info.id, info);
  } catch {
    return map;
  }
  const missing = active.filter((a) => !map.has(a.downloadId));
  if (missing.length > 0) {
    const extra = await Promise.all(
      missing.map((a) => chrome.downloads.search({ id: a.downloadId }).catch(() => [])),
    );
    for (const items of extra) for (const info of items) map.set(info.id, info);
  }
  return map;
}

/**
 * chrome.downloads.onChanged 的 delta 里没有 bytesReceived，
 * 进度必须用 chrome.downloads.search 拿。
 */
async function poll(): Promise<void> {
  const active: Array<{ record: TaskRecord; downloadId: number; itemId: string }> = [];
  for (const record of tasks.values()) {
    for (const [downloadId, itemId] of record.running.entries()) {
      active.push({ record, downloadId, itemId });
    }
  }
  if (active.length === 0) return;

  const infos = await fetchRunning(active);
  if (infos.size === 0) return;

  const now = Date.now();
  for (const entry of active) {
    const info = infos.get(entry.downloadId);
    if (!info) continue;
    const item = entry.record.items.find((i) => i.itemId === entry.itemId);
    if (!item) continue;

    const received = info.bytesReceived ?? item.bytesReceived;
    const total = info.totalBytes && info.totalBytes > 0 ? info.totalBytes : item.totalBytes;

    const prev = entry.record.lastTick.get(entry.itemId) ?? { at: now, bytes: received };
    const dt = (now - prev.at) / 1000;
    if (dt >= 0.4) {
      const speed = Math.max(0, (received - prev.bytes) / dt);
      if (item.speed !== speed) {
        item.speed = speed;
        entry.record.dirty.add(entry.itemId);
      }
      entry.record.lastTick.set(entry.itemId, { at: now, bytes: received });
    }

    if (item.bytesReceived !== received) {
      item.bytesReceived = received;
      entry.record.dirty.add(entry.itemId);
    }
    if (total !== item.totalBytes) {
      item.totalBytes = total;
      entry.record.dirty.add(entry.itemId);
    }
    if (info.filename) item.filename = info.filename;

    if (info.state === 'complete') {
      // 浏览器说完成了但文件是 0 字节 —— 这种情况必须当失败，
      // 否则用户以为下好了，硬盘上却什么都没有
      if (info.fileSize === 0) {
        entry.record.running.delete(info.id);
        item.state = 'failed';
        item.error = '下载完成但文件为空，已标记为失败';
        item.speed = undefined;
        entry.record.summary.failed += 1;
        entry.record.dirty.add(entry.itemId);
        await broadcast(entry.record);
        await pump(entry.record);
        await checkFinished(entry.record);
        continue;
      }
      item.state = 'completed';
      item.bytesReceived = info.bytesReceived ?? received;
      item.totalBytes = info.totalBytes && info.totalBytes > 0 ? info.totalBytes : item.totalBytes;
      item.speed = undefined;
      entry.record.running.delete(info.id);
      entry.record.summary.completed += 1;
      entry.record.dirty.add(entry.itemId);
      bumpSessionStats(info.bytesReceived ?? 0);
      await broadcast(entry.record);
      await pump(entry.record);
      await checkFinished(entry.record);
    } else if (info.state === 'interrupted') {
      entry.record.running.delete(info.id);
      item.speed = undefined;
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
          entry.record.dirty.add(entry.itemId);
          await broadcast(entry.record);
          scheduleRetry(entry.record, 1000 * 2 ** (attempts - 1));
          continue;
        }
        item.state = 'failed';
        item.error = error;
        entry.record.summary.failed += 1;
      }
      entry.record.dirty.add(entry.itemId);
      await broadcast(entry.record);
      await pump(entry.record);
      await checkFinished(entry.record);
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

/**
 * 安排一次刷新。
 *
 * 下载事件和兜底节拍都走这里，天然会合并 —— 一串密集的事件
 * 只会变成一次 downloads.search。
 */
function scheduleTick(): void {
  if (tickTimer) return;
  const wait = Math.max(0, MIN_TICK_GAP - (Date.now() - lastTickAt));
  tickTimer = setTimeout(() => {
    tickTimer = null;
    void tick();
  }, wait);
  (tickTimer as unknown as { unref?: () => void })?.unref?.();
}

/** 真正去查一次进度 */
async function tick(): Promise<void> {
  if (ticking) return;
  ticking = true;
  lastTickAt = Date.now();
  try {
    await poll();
  } catch {
    /* ignore */
  } finally {
    ticking = false;
  }
}

function ensureHeartbeat(): void {
  const hasActive = [...tasks.values()].some((t) => t.running.size > 0 || t.queue.length > 0);
  if (!hasActive) {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
    return;
  }
  if (heartbeatTimer) return;
  heartbeatTimer = setInterval(() => scheduleTick(), TICK_INTERVAL);
  // Node 下（单元测试）定时器会吊住进程；浏览器里 setInterval 返回数字，没有这方法
  (heartbeatTimer as unknown as { unref?: () => void })?.unref?.();
}

/* ------------------------------------------------------------------ */
/* chrome.downloads 事件                                               */
/* ------------------------------------------------------------------ */

export function attachDownloadListeners(): void {
  chrome.downloads.onChanged.addListener((delta) => {
    // 事件本身不带进度数字，真正要拿还得查一次；
    // 所以这里只负责「唤醒」，由合并后的定时器统一去查。
    // 之前是每个事件直接打一次全量查询，查询量 = 事件数 × 并发数。
    const state = (delta as { state?: { current?: string } }).state?.current;
    if (state === 'complete' || state === 'interrupted') scheduleTick();
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
  ensureHeartbeat();
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
    if (item.state === 'queued') {
      item.state = 'cancelled';
      record.dirty.add(item.itemId);
    }
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
  record.dirty.add(itemId);
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
  ensureHeartbeat();
}
