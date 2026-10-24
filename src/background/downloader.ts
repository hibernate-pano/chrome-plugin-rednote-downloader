import type {
  DownloadMode,
  DownloadProgress,
  DownloadState,
  DownloadTaskItem,
  DownloadTaskSnapshot,
  PackItem,
  Settings,
  TaskSummary,
} from '../shared/types';
import { DEFAULT_SETTINGS } from '../shared/types';
import type { HistoryEntry, OffscreenToWorker } from '../shared/messages';
import { sanitizeSegment } from '../shared/utils';

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
  /** 这个任务用哪个引擎下载：交给浏览器 / 打包成一个 zip */
  engine: DownloadMode;
  items: DownloadProgress[];
  queue: string[];
  /**
   * 在途条目：key → itemId。
   *
   * key 带引擎前缀（d=浏览器下载 id，z=打包任务），
   * 这样两个引擎的在途条目能放在同一张表里互不干扰。
   * 一律用字符串：存进 storage.session 再读回来时数字会变成字符串，
   * 用数字当 key 会出现「删不掉」的幽灵条目。
   */
  running: Map<string, string>;
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
  /** zip 模式：包的名字（不含扩展名） */
  packName?: string;
  /** zip 模式：包已经交给浏览器下载的 id */
  downloadId?: number;
  /** zip 模式：打好的包（下载完了要删掉） */
  packFiles?: { dirName: string; packNames: string[] };
  /** zip 模式：包打算存到哪里（相对浏览器的下载目录） */
  packPaths?: string[];
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
          engine: (item.engine ?? 'browser') as DownloadMode,
          // 旧版本存的是数字 key，读回来是字符串，而且没有引擎前缀。
          // 这里统一补上 'd' 前缀，不然浏览器引擎认不出在途条目。
          running: new Map(
            (item.running ?? []).map(([key, value]: [unknown, string]) => [
              typeof key === 'string' && (key.startsWith('d:') || key.startsWith('z:'))
                ? key
                : `d:${key}`,
              value,
            ]),
          ),
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

export interface StartResult {
  /** true = 正在等用户选保存目录，调用方需要弹出选目录窗口 */
  waiting: boolean;
}

/**
 * 打包模式下的「在途条目」占位 id。
 *
 * 打包模式下整批只有一次（或几次）浏览器下载 —— 用这个假 id 占位，
 * 让下载进度能挂到任务上，被现有的进度刷新机制跟到。
 */
const ZIP_SLOT = '__zip__';

/**
 * 单个包的大小上限。
 *
 * 标准 zip（不带 ZIP64）单个文件不能超过 4GB，
 * 几百个视频很容易超 —— 超了就分成几个包，宁可多几个也不生成解不开的文件。
 */
const MAX_PACK_BYTES = 2 * 1024 * 1024 * 1024;

/** 只有一个文件时没什么好打包的，直接丢给浏览器下载 */
function shouldPack(items: DownloadTaskItem[]): boolean {
  return items.length > 1;
}

/** 包的名字：作者 + 时间。多个包时后面会加 -2、-3 */
function buildPackName(items: DownloadTaskItem[]): string {
  const author = items.find((item) => item.author)?.author?.trim();
  const now = new Date();
  const stamp = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
    '-',
    String(now.getHours()).padStart(2, '0'),
    String(now.getMinutes()).padStart(2, '0'),
  ].join('');
  const who = author ? sanitizeSegment(author, 24) : '';
  return who ? `小红书-${who}-${stamp}` : `小红书下载-${stamp}`;
}

export async function startDownloads(
  tabId: number | undefined,
  taskId: string,
  items: DownloadTaskItem[],
): Promise<StartResult> {
  const settings = await getSettings();
  const pack = settings.downloadMode === 'zip' && shouldPack(items);
  const record: TaskRecord = {
    taskId,
    tabId,
    engine: pack ? 'zip' : 'browser',
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

  if (pack) {
    await startPack(record, settings, items);
    return { waiting: false };
  }

  await pump(record);
  // 在途下载的 id 记在 running 里，Service Worker 被杀之后要靠它对账，
  // 所以这里必须立刻落盘一次，不能等节流
  await persist();
  return { waiting: false };
}

/* ------------------------------------------------------------------ */
/* 打包                                                                */
/* ------------------------------------------------------------------ */

/**
 * 启动一次打包。
 *
 * 打包在后台页面（offscreen）里跑：Service Worker 空闲 30 秒就会被杀，
 * 几百个文件的活儿扛不住；后台页面没有这个限制。
 */
async function startPack(
  record: TaskRecord,
  settings: Settings,
  sources: DownloadTaskItem[],
  suffix = '',
): Promise<void> {
  const packItems: PackItem[] = sources.map((source) => ({
    itemId: source.itemId,
    url: source.url,
    // 包里的路径不要重复根文件夹 —— 包本身就是根
    path: stripRootFolder(source.filename, settings.rootFolder),
    size: source.size,
  }));

  for (const item of record.items) {
    if (item.state === 'queued' || item.state === 'failed') {
      item.state = 'downloading';
      item.error = undefined;
      item.bytesReceived = 0;
    }
    record.dirty.add(item.itemId);
  }
  record.engine = 'zip';
  record.running.set('z:pack', 'pack');
  record.packName = `${buildPackName(sources)}${suffix}`;
  await broadcast(record, true);
  await persist();

  try {
    // 后台页面得先开着（第一次用时才创建）
    await ensureOffscreen();
    const ok = await sendToOffscreen({
      type: 'ZIP_START',
      taskId: record.taskId,
      items: packItems,
      concurrency: settings.concurrency,
      maxZipBytes: MAX_PACK_BYTES,
      packName: record.packName,
      rootFolder: sanitizeSegment(settings.rootFolder, 40),
    });
    if (!ok) throw new Error('后台页面启动失败');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    for (const item of record.items) {
      if (item.state !== 'downloading') continue;
      item.state = 'failed';
      item.error = message;
      record.summary.failed += 1;
      record.dirty.add(item.itemId);
    }
    record.running.delete('z:pack');
    await persist();
    await broadcast(record, true);
    await checkFinished(record);
  }
}

/** 去掉路径最前面的根文件夹（包自己就是根） */
function stripRootFolder(filename: string, rootFolder: string): string {
  const root = sanitizeSegment(rootFolder, 40);
  if (!root) return filename;
  const prefix = `${root}/`;
  return filename.startsWith(prefix) ? filename.slice(prefix.length) : filename;
}

/** 后台页面（offscreen）是否已经开着 */
async function hasOffscreen(): Promise<boolean> {
  try {
    return await chrome.offscreen.hasDocument();
  } catch {
    return false;
  }
}

/** 保证后台页面开着 */
async function ensureOffscreen(): Promise<void> {
  if (await hasOffscreen()) return;
  try {
    await chrome.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: [chrome.offscreen.Reason.BLOBS],
      justification: '把打包好的压缩包交给浏览器的下载管理器保存到磁盘',
    });
  } catch (err) {
    // 「已经有后台页面了」不算错
    if (!/only a single offscreen/i.test(String(err))) throw err;
  }
}

/**
 * 给后台页面发消息。
 *
 * 刚创建的后台页面，脚本可能还没跑起来 —— 这时候发消息会收到
 * 「没有接收端」。重试几次就好。
 */
async function sendToOffscreen(message: unknown): Promise<boolean> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      const response = (await chrome.runtime.sendMessage(message)) as { ok?: boolean } | undefined;
      if (response?.ok) return true;
      return false;
    } catch (err) {
      const text = String(err);
      if (!/receiving end|message port closed/i.test(text)) return false;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  return false;
}

/**
 * 后台页面报回来的进度与结果。
 */
export async function handleOffscreenEvent(message: OffscreenToWorker): Promise<void> {
  const record = tasks.get(message.taskId);
  if (!record) return;

  if (message.type === 'ZIP_ITEM_PROGRESS') {
    const item = record.items.find((i) => i.itemId === message.itemId);
    if (!item) return;
    const now = Date.now();
    item.bytesReceived = message.received;
    if (message.total > 0) item.totalBytes = message.total;
    const prev = record.lastTick.get(item.itemId) ?? { at: now, bytes: message.received };
    const dt = (now - prev.at) / 1000;
    if (dt >= 0.4) {
      item.speed = Math.max(0, (message.received - prev.bytes) / dt);
      record.lastTick.set(item.itemId, { at: now, bytes: message.received });
    }
    record.dirty.add(item.itemId);
    schedulePersist();
    void broadcast(record);
    return;
  }

  if (message.type === 'ZIP_ITEM_DONE') {
    const item = record.items.find((i) => i.itemId === message.itemId);
    if (!item) return;
    item.bytesReceived = Math.max(item.bytesReceived, message.bytes);
    if (item.totalBytes <= 0) item.totalBytes = message.bytes;
    item.speed = undefined;
    record.dirty.add(item.itemId);
    void broadcast(record);
    return;
  }

  if (message.type === 'ZIP_ITEM_FAILED') {
    const item = record.items.find((i) => i.itemId === message.itemId);
    if (!item) return;
    item.state = 'failed';
    item.error = message.error;
    item.speed = undefined;
    record.summary.failed += 1;
    record.dirty.add(item.itemId);
    void broadcast(record);
    return;
  }

  if (message.type === 'ZIP_FAILED') {
    record.running.delete('z:pack');
    for (const item of record.items) {
      if (item.state !== 'downloading') continue;
      item.state = 'failed';
      item.error = message.error;
      item.speed = undefined;
      record.summary.failed += 1;
      record.dirty.add(item.itemId);
    }
    record.queue = [];
    await persist();
    await broadcast(record, true);
    await checkFinished(record);
    return;
  }

  // ZIP_PACKS_READY：包打好了，交给浏览器下载
  if (message.type === 'ZIP_PACKS_READY') {
    await startPackDeliveries(record, message.packs);
  }
}

/**
 * 把打好的包交给 Chrome 的下载管理器。
 *
 * 整批只有一次（或几次）下载 —— 浏览器只处理这几条，
 * 几百个文件也只占一两条下载记录。
 */
async function startPackDeliveries(
  record: TaskRecord,
  packs: { dirName: string; name: string; objectUrl: string; downloadPath: string }[],
): Promise<void> {
  record.running.delete('z:pack');
  const started: number[] = [];
  for (const pack of packs) {
    try {
      const downloadId = await chrome.downloads.download({
        url: pack.objectUrl,
        filename: pack.downloadPath,
        conflictAction: 'uniquify',
        saveAs: false,
      });
      started.push(downloadId);
      record.running.set(`d:${downloadId}`, ZIP_SLOT);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      for (const item of record.items) {
        if (item.state !== 'downloading') continue;
        item.state = 'failed';
        item.error = message;
        record.summary.failed += 1;
        record.dirty.add(item.itemId);
      }
    }
  }
  record.downloadId = started[0];
  record.packFiles = {
    dirName: packs[0]?.dirName ?? '',
    packNames: packs.map((pack) => pack.name),
  };
  record.packPaths = packs.map((pack) => pack.downloadPath);
  await persist();
  await broadcast(record, true);
  ensureHeartbeat();
}

/**
 * 打包的最后一个包落盘了：把条目标记完成，让后台页面把临时文件删掉。
 */
async function finishPackTask(record: TaskRecord, dirName: string, packNames: string[]): Promise<void> {
  for (const item of record.items) {
    if (item.state !== 'downloading') continue;
    item.state = 'completed';
    item.speed = undefined;
    record.summary.completed += 1;
    record.dirty.add(item.itemId);
    bumpSessionStats(item.bytesReceived);
  }
  record.queue = [];
  await persist();
  await broadcast(record, true);
  // 让后台页面把 OPFS 里的临时包删掉（省磁盘）
  void chrome.runtime
    .sendMessage({ type: 'ZIP_CLEANUP', taskId: record.taskId, dirName, packNames })
    .catch(() => undefined);
  await checkFinished(record);
}

/**
 * 启动队列。
 *
 * 两个引擎在这里分流：浏览器引擎用 chrome.downloads.download 起步，
 * 打包引擎已经把活儿交给后台页面了，这里只负责刷新界面。
 * 队列、并发、重试、统计的逻辑两边共用。
 */
async function pump(record: TaskRecord): Promise<void> {
  const settings = await getSettings();
  const limit = Math.max(1, Math.min(8, settings.concurrency));

  // 打包模式：进度由后台页面报回来，这里不碰队列
  if (record.engine === 'zip') {
    ensureHeartbeat();
    await broadcast(record);
    return;
  }

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
      record.running.set(`d:${downloadId}`, itemId);
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
    // 只看浏览器下载的在途条目（key 带 d: 前缀）。
    // 打包模式的最后一步也是一次浏览器下载，同样要跟。
    for (const [key, itemId] of record.running.entries()) {
      if (!key.startsWith('d:')) continue;
      active.push({ record, downloadId: Number(key.slice(2)), itemId });
    }
  }
  if (active.length === 0) return;

  const infos = await fetchRunning(active);
  if (infos.size === 0) return;

  const now = Date.now();
  for (const entry of active) {
    const info = infos.get(entry.downloadId);
    if (!info) continue;

    // 打包模式：整批只有一次下载，它落盘了就是整批落盘了
    if (entry.itemId === ZIP_SLOT) {
      if (info.state === 'complete') {
        entry.record.running.delete(`d:${info.id}`);
        const stillRunning = Array.from(entry.record.running.keys()).some((k) =>
          k.startsWith('d:'),
        );
        if (!stillRunning && entry.record.engine === 'zip') {
          const files = entry.record.packFiles;
          await finishPackTask(
            entry.record,
            files?.dirName ?? '',
            files?.packNames ?? [],
          );
        }
      } else if (info.state === 'interrupted') {
        entry.record.running.delete(`d:${info.id}`);
        const error = info.error ?? '保存压缩包时中断了';
        for (const item of entry.record.items) {
          if (item.state !== 'downloading') continue;
          item.state = 'failed';
          item.error = error;
          item.speed = undefined;
          entry.record.summary.failed += 1;
          entry.record.dirty.add(item.itemId);
        }
        await broadcast(entry.record);
        await checkFinished(entry.record);
      }
      continue;
    }

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
        entry.record.running.delete(`d:${info.id}`);
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
      entry.record.running.delete(`d:${info.id}`);
      entry.record.summary.completed += 1;
      entry.record.dirty.add(entry.itemId);
      bumpSessionStats(info.bytesReceived ?? 0);
      await broadcast(entry.record);
      await pump(entry.record);
      await checkFinished(entry.record);
    } else if (info.state === 'interrupted') {
      entry.record.running.delete(`d:${info.id}`);
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
    // 自研引擎的进度是「事件驱动」的（每收到一块数据就更新条目），
    // 这里统一把变过的条目推给页面 —— 广播本身有节流，不会刷屏
    for (const record of tasks.values()) await broadcast(record);
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

  if (record.engine === 'zip') {
    // 打包模式：让后台页面停下，同时把已经开始的那次下载也停掉
    void chrome.runtime.sendMessage({ type: 'ZIP_CANCEL', taskId }).catch(() => undefined);
    for (const key of record.running.keys()) {
      if (!key.startsWith('d:')) continue;
      await chrome.downloads.cancel(Number(key.slice(2))).catch(() => undefined);
    }
  } else {
    for (const key of record.running.keys()) {
      if (!key.startsWith('d:')) continue;
      await chrome.downloads.cancel(Number(key.slice(2))).catch(() => undefined);
    }
  }

  record.queue = [];
  record.items.forEach((item) => {
    if (item.state === 'queued' || item.state === 'waiting') {
      item.state = 'cancelled';
      record.dirty.add(item.itemId);
    }
  });
  await persist();
  await broadcast(record, true);
  await checkFinished(record);
}

/** 重试单个失败的下载项 */
export async function retryItem(taskId: string, itemId: string): Promise<StartResult> {
  const record = tasks.get(taskId);
  if (!record) return { waiting: false };
  const item = record.items.find((i) => i.itemId === itemId);
  if (!item || item.state === 'downloading' || item.state === 'completed') {
    return { waiting: false };
  }

  const source = record.sources.get(itemId);
  if (!source) return { waiting: false };

  item.state = 'queued';
  item.bytesReceived = 0;
  item.error = undefined;
  item.downloadId = undefined;
  item.totalBytes = source.size ?? -1;
  record.summary.failed = Math.max(0, record.summary.failed - 1);
  record.dirty.add(itemId);

  if (record.engine === 'zip') {
    // 打包模式没法「补一个文件进已经打好的包」，
    // 所以把没下成功的几个重新打一个包（叫「xxx-补.zip」）。
    const pending = record.items
      .filter((i) => i.state === 'failed' || i.state === 'queued')
      .map((i) => record.sources.get(i.itemId))
      .filter((s): s is DownloadTaskItem => Boolean(s));
    const settings = await getSettings();
    await startPack(record, settings, pending, '-补');
    return { waiting: false };
  }

  record.queue.push(itemId);
  await persist();
  await broadcast(record, true);

  await pump(record);
  return { waiting: false };
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
 * 状态本身存在 storage.session 里所以不会丢，但「这个下载还在不在」必须重新确认 ——
 * 不确认的话，那一项会永远卡在「下载中」，进度条一直转。
 *
 * 两个引擎的答案不一样：
 *   - 浏览器引擎：问 Chrome 还在不在下（downloads.search）。
 *     浏览器那边的下载服务独立于 SW，SW 死了下载还在，所以查得到就继续跟。
 *   - 打包模式：活儿在后台页面里跑，SW 死了它照跑 ——
 *     后台页面最后会把结果报回来，SW 会被这条消息唤醒。
 */
async function reconcile(record: TaskRecord): Promise<void> {
  if (record.running.size === 0) return;

  if (record.engine === 'zip') {
    // 后台页面可能已经被浏览器回收了（扩展重载、浏览器退出）——
    // 那这个任务就没人接手了，直接标失败让用户重试。
    if (!(await hasOffscreen())) {
      for (const item of record.items) {
        if (item.state !== 'downloading') continue;
        item.state = 'failed';
        item.error = '打包被浏览器中断，请重试';
        item.speed = undefined;
        record.summary.failed += 1;
        record.dirty.add(item.itemId);
      }
      record.running.delete('z:pack');
    }
    return;
  }

  const entries = Array.from(record.running.entries()).filter(([key]) => key.startsWith('d:'));
  const results = await Promise.all(
    entries.map(([key]) =>
      chrome.downloads
        .search({ id: Number(key.slice(2)) })
        .catch(() => [] as chrome.downloads.DownloadItem[]),
    ),
  );

  for (let i = 0; i < entries.length; i += 1) {
    const [key, itemId] = entries[i]!;
    const found = results[i] ?? [];
    const info = found[0];
    if (info) continue; // 浏览器还认得，交给 poll 继续跟

    const item = record.items.find((x) => x.itemId === itemId);
    record.running.delete(key);
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

    if (record.engine === 'zip') {
      // 打包在后台页面里跑，队列由后台页面管，这里不用管
      record.queue = [];
      await persist();
      await broadcast(record, true);
      continue;
    }

    void pump(record);
  }
  ensureHeartbeat();
}
