/**
 * 下载队列的单元测试：重试、空文件判定、Service Worker 重启自愈。
 *
 * 这些逻辑跑在 Service Worker 里，直接测不方便，所以这里用 chrome API 桩
 * 把 background/downloader.ts 的行为驱动起来 —— 桩的行为按 Chromium 真实语义写：
 *   - downloads.search 返回浏览器认得的那批下载
 *   - downloads.download 抛错 = 整个下载没发生（这是 filename 非法的真实后果）
 *   - SW 重启 = 重新 import 模块（内存态丢失，只剩 storage.session）
 *
 * 运行：npm test
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/* ------------------------------------------------------------------ */
/* chrome API 桩                                                        */
/* ------------------------------------------------------------------ */

interface FakeDownload {
  id: number;
  state: 'in_progress' | 'complete' | 'interrupted';
  bytesReceived: number;
  totalBytes: number;
  fileSize?: number;
  error?: string;
  filename: string;
}

interface FakeChrome {
  downloads: {
    download: (opts: { url: string; filename: string }) => Promise<number>;
    search: (q: { id?: number }) => Promise<FakeDownload[]>;
    cancel: (id: number) => Promise<void>;
    removeFile: (id: number) => Promise<void>;
    show: (id: number) => Promise<void>;
    onChanged: { addListener: (fn: (delta: unknown) => void) => void };
  };
  storage: {
    session: {
      get: (key: string) => Promise<Record<string, unknown>>;
      set: (obj: Record<string, unknown>) => Promise<void>;
    };
    local: {
      get: (key: string) => Promise<Record<string, unknown>>;
      set: (obj: Record<string, unknown>) => Promise<void>;
    };
  };
  runtime: { sendMessage: (msg: unknown) => Promise<unknown> };
  tabs: { sendMessage: (tabId: number, msg: unknown) => Promise<unknown> };
  offscreen: {
    createDocument: (opts: unknown) => Promise<void>;
    hasDocument: () => Promise<boolean>;
    Reason: { BLOBS: string };
  };
}

const sessionStore: Record<string, unknown> = {};

/** 桩的状态：下一次 download() 干什么、search() 返回什么 */
const stub = {
  nextDownload: [] as Array<{ ok: true; id: number } | { ok: false; error: string }>,
  downloads: new Map<number, FakeDownload>(),
  nextId: 1,
  settings: {} as Record<string, unknown>,
  /** downloads.download 被调用了几次（判断「有没有真的去起下载」） */
  downloadCalls: 0,
  /** runtime.sendMessage 收到过什么（用来断言「取消时通知了后台页面」） */
  sentMessages: [] as Array<{ type?: string }>,
};

function installChrome(): FakeChrome {
  // 每个用例都从干净的桩开始 —— 否则上一条用例留下的发信记录和下载历史
  // 会让「只发了一次」这种断言变成「只发了一次 + 前面那些」。
  stub.sentMessages.length = 0;
  stub.settings['rednote.history'] = [];
  // 这些用例测的是「交给浏览器下载」那条路径，
  // 所以把下载方式显式设成 browser（默认是扩展自己写盘）。
  stub.settings['rednote.settings'] = { downloadMode: 'browser' };
  const fake: FakeChrome = {
    downloads: {
      download: async () => {
        stub.downloadCalls += 1;
        const step = stub.nextDownload.shift();
        if (!step) throw new Error('没有预置的 download 结果');
        if (!step.ok) throw new Error(step.error);
        return step.id;
      },
      search: async (q) => {
        if (q.id === undefined) return [...stub.downloads.values()];
        const found = stub.downloads.get(q.id);
        return found ? [found] : [];
      },
      cancel: async () => undefined,
      removeFile: async () => undefined,
      show: async () => undefined,
      onChanged: { addListener: () => undefined },
    },
    storage: {
      session: {
        get: async (key) => (key in sessionStore ? { [key]: sessionStore[key] } : {}),
        set: async (obj) => {
          Object.assign(sessionStore, obj);
        },
      },
      local: {
        get: async (key) => (key in stub.settings ? { [key]: stub.settings[key] } : {}),
        set: async (obj) => {
          Object.assign(stub.settings, obj);
        },
      },
    },
    runtime: {
      sendMessage: async (msg) => {
        stub.sentMessages.push(msg as { type?: string });
        // 打包模式：后台页面收到 ZIP_START 要立刻回话「收到了」
        if ((msg as { type?: string })?.type === 'ZIP_START') return { ok: true };
        return undefined;
      },
    },
    tabs: { sendMessage: async () => undefined },
    offscreen: {
      createDocument: async () => undefined,
      hasDocument: async () => true,
      Reason: { BLOBS: 'BLOBS' },
    },
  };
  (globalThis as any).chrome = fake;
  return fake;
}

/**
 * 每次 import 都是一份全新的模块实例 —— 正好模拟 Service Worker 被杀掉再拉起。
 * 模块用 query string 打破 ESM 的缓存（所以 downloader.ts 必须单独打包成文件，
 * 不能被 esbuild 内联进测试 bundle）。
 */
let importCounter = 0;
async function freshDownloader() {
  importCounter += 1;
  const url = `${pathToFileURL(
    path.resolve(process.cwd(), 'build/test/_downloader.mjs'),
  ).href}?gen=${importCounter}`;
  return import(url);
}

/** 让轮询跑一轮：桩里的 download 状态是同步可变的，跑一次 poll 就能看到结果 */
async function settle(ms = 120): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

/* ------------------------------------------------------------------ */
/* 用例                                                                 */
/* ------------------------------------------------------------------ */

test('download：正常下载会完成并计入统计', async () => {
  installChrome();
  const mod = await freshDownloader();
  stub.nextDownload = [{ ok: true, id: 1 }];
  stub.downloads.set(1, {
    id: 1,
    state: 'in_progress',
    bytesReceived: 500,
    totalBytes: 1000,
    filename: '1.jpg',
  });

  await mod.startDownloads(undefined, 'task-1', [
    { itemId: 'i1', url: 'https://cdn/x.jpg', filename: '1.jpg', kind: 'image' },
  ]);
  await settle();

  // 模拟浏览器报告完成
  stub.downloads.set(1, {
    id: 1,
    state: 'complete',
    bytesReceived: 1000,
    totalBytes: 1000,
    fileSize: 1000,
    filename: '1.jpg',
  });
  await settle(700);

  const snap = mod.getTaskSnapshot('task-1');
  assert.equal(snap?.items[0]?.state, 'completed');
  assert.equal(snap?.summary.completed, 1);
});

test('download：浏览器说完成但文件是 0 字节 —— 判为失败而不是成功', async () => {
  installChrome();
  const mod = await freshDownloader();
  stub.nextDownload = [{ ok: true, id: 2 }];
  stub.downloads.set(2, {
    id: 2,
    state: 'in_progress',
    bytesReceived: 0,
    totalBytes: 0,
    filename: 'empty.jpg',
  });

  await mod.startDownloads(undefined, 'task-2', [
    { itemId: 'i1', url: 'https://cdn/x.jpg', filename: 'empty.jpg', kind: 'image' },
  ]);
  await settle();

  stub.downloads.set(2, {
    id: 2,
    state: 'complete',
    bytesReceived: 0,
    totalBytes: 0,
    fileSize: 0,
    filename: 'empty.jpg',
  });
  await settle(700);

  const snap = mod.getTaskSnapshot('task-2');
  assert.equal(snap?.items[0]?.state, 'failed', '0 字节文件被当成了成功');
  assert.equal(snap?.summary.completed, 0);
  assert.equal(snap?.summary.failed, 1);
});

test('download：网络中断会自动重试，状态是 retrying 而不是 failed', async () => {
  installChrome();
  const mod = await freshDownloader();
  stub.nextDownload = [
    { ok: true, id: 3 },
    { ok: true, id: 4 },
  ];
  stub.downloads.set(3, {
    id: 3,
    state: 'in_progress',
    bytesReceived: 100,
    totalBytes: 1000,
    filename: '1.jpg',
  });

  await mod.startDownloads(undefined, 'task-3', [
    { itemId: 'i1', url: 'https://cdn/x.jpg', filename: '1.jpg', kind: 'image' },
  ]);
  await settle();

  // 第一次：网络故障
  stub.downloads.set(3, {
    id: 3,
    state: 'interrupted',
    bytesReceived: 100,
    totalBytes: 1000,
    error: 'NETWORK_FAILED',
    filename: '1.jpg',
  });
  await settle(700);

  const retrying = mod.getTaskSnapshot('task-3');
  assert.equal(retrying?.items[0]?.state, 'retrying');
  assert.equal(retrying?.summary.failed, 0, '重试中不该算失败');
  assert.match(String(retrying?.items[0]?.error), /NETWORK_FAILED/);

  // 第二次成功
  stub.downloads.set(4, {
    id: 4,
    state: 'in_progress',
    bytesReceived: 0,
    totalBytes: 1000,
    filename: '1.jpg',
  });
  await settle(1400);
  stub.downloads.set(4, {
    id: 4,
    state: 'complete',
    bytesReceived: 1000,
    totalBytes: 1000,
    fileSize: 1000,
    filename: '1.jpg',
  });
  await settle(700);

  const done = mod.getTaskSnapshot('task-3');
  assert.equal(done?.items[0]?.state, 'completed');
  assert.equal(done?.summary.completed, 1);
  assert.equal(done?.summary.failed, 0);
});

test('download：用户主动取消不算失败', async () => {
  installChrome();
  const mod = await freshDownloader();
  stub.nextDownload = [{ ok: true, id: 5 }];
  stub.downloads.set(5, {
    id: 5,
    state: 'in_progress',
    bytesReceived: 10,
    totalBytes: 100,
    filename: '1.jpg',
  });

  await mod.startDownloads(undefined, 'task-4', [
    { itemId: 'i1', url: 'https://cdn/x.jpg', filename: '1.jpg', kind: 'image' },
  ]);
  await settle();

  stub.downloads.set(5, {
    id: 5,
    state: 'interrupted',
    bytesReceived: 10,
    totalBytes: 100,
    error: 'USER_CANCELED',
    filename: '1.jpg',
  });
  await settle(700);

  const snap = mod.getTaskSnapshot('task-4');
  assert.equal(snap?.items[0]?.state, 'cancelled');
  assert.equal(snap?.summary.failed, 0);
});

test('download：重试超过上限后判为失败，不会无限重试', async () => {
  installChrome();
  const mod = await freshDownloader();
  // 首次 + 2 次自动重试 = 3 次 download 调用
  stub.nextDownload = [
    { ok: true, id: 6 },
    { ok: true, id: 7 },
    { ok: true, id: 8 },
  ];
  stub.downloads.set(6, {
    id: 6,
    state: 'in_progress',
    bytesReceived: 10,
    totalBytes: 100,
    filename: '1.jpg',
  });

  await mod.startDownloads(undefined, 'task-5', [
    { itemId: 'i1', url: 'https://cdn/x.jpg', filename: '1.jpg', kind: 'image' },
  ]);
  await settle();

  for (const id of [6, 7, 8]) {
    stub.downloads.set(id, {
      id,
      state: 'interrupted',
      bytesReceived: 10,
      totalBytes: 100,
      error: 'NETWORK_FAILED',
      filename: '1.jpg',
    });
    await settle(1600);
  }

  const snap = mod.getTaskSnapshot('task-5');
  assert.equal(snap?.items[0]?.state, 'failed');
  assert.equal(snap?.summary.failed, 1);
  // 只有 3 次 download 调用 —— 没有无限重试
  assert.equal(stub.nextDownload.length, 0);
});

test('SW 重启：浏览器已经认不出的下载项会被标失败，不会永远卡在「下载中」', async () => {
  installChrome();
  const first = await freshDownloader();
  stub.nextDownload = [{ ok: true, id: 9 }];
  stub.downloads.set(9, {
    id: 9,
    state: 'in_progress',
    bytesReceived: 50,
    totalBytes: 100,
    filename: '1.jpg',
  });

  await first.startDownloads(undefined, 'task-6', [
    { itemId: 'i1', url: 'https://cdn/x.jpg', filename: '1.jpg', kind: 'image' },
  ]);
  await settle();

  // 模拟 SW 被杀：浏览器那边把这个下载记录清了
  stub.downloads.delete(9);

  // 重新拉起 SW —— 内存态清空，只剩 storage.session
  const second = await freshDownloader();
  await second.initDownloader();
  await settle(700);

  const snap = second.getTaskSnapshot('task-6');
  assert.ok(snap, '任务应该从 storage.session 恢复出来');
  assert.equal(snap?.items[0]?.state, 'failed');
  assert.match(String(snap?.items[0]?.error), /丢失/);
});

test('SW 重启：浏览器还在下载的项保持「下载中」，不会被误判失败', async () => {
  installChrome();
  const first = await freshDownloader();
  stub.nextDownload = [{ ok: true, id: 10 }];
  stub.downloads.set(10, {
    id: 10,
    state: 'in_progress',
    bytesReceived: 50,
    totalBytes: 100,
    filename: '1.jpg',
  });

  await first.startDownloads(undefined, 'task-7', [
    { itemId: 'i1', url: 'https://cdn/x.jpg', filename: '1.jpg', kind: 'image' },
  ]);
  await settle();

  const second = await freshDownloader();
  await second.initDownloader();
  await settle(700);

  const snap = second.getTaskSnapshot('task-7');
  assert.equal(snap?.items[0]?.state, 'downloading');
  assert.equal(snap?.summary.failed, 0);
});

/* ------------------------------------------------------------------ */
/* 取消                                                                */
/* ------------------------------------------------------------------ */

test('取消：正在下载的条目也落到 cancelled，任务不会卡在「下载中」', async () => {
  installChrome();
  const mod = await freshDownloader();
  // 默认并发 3：四个文件里三个在下载、一个还在排队
  stub.nextDownload = [
    { ok: true, id: 21 },
    { ok: true, id: 22 },
    { ok: true, id: 23 },
  ];
  for (const id of [21, 22, 23]) {
    stub.downloads.set(id, {
      id,
      state: 'in_progress',
      bytesReceived: 10,
      totalBytes: 100,
      filename: `${id}.jpg`,
    });
  }

  await mod.startDownloads(undefined, 'task-8', [
    { itemId: 'i1', url: 'https://cdn/1.jpg', filename: '1.jpg', kind: 'image' },
    { itemId: 'i2', url: 'https://cdn/2.jpg', filename: '2.jpg', kind: 'image' },
    { itemId: 'i3', url: 'https://cdn/3.jpg', filename: '3.jpg', kind: 'image' },
    { itemId: 'i4', url: 'https://cdn/4.jpg', filename: '4.jpg', kind: 'image' },
  ]);
  await settle();

  // 三个正在下、一个还在排队 —— 这时候点取消
  const before = mod.getTaskSnapshot('task-8');
  assert.deepEqual(
    before?.items.map((i) => i.state),
    ['downloading', 'downloading', 'downloading', 'queued'],
    '前提：三个在下载、一个在排队',
  );

  await mod.cancelTask('task-8');

  const snap = mod.getTaskSnapshot('task-8');
  assert.deepEqual(
    snap?.items.map((i) => i.state),
    ['cancelled', 'cancelled', 'cancelled', 'cancelled'],
    '取消之后不能有任何条目还停在 downloading / queued',
  );
  assert.equal(snap?.summary.failed, 0, '用户自己取消的不算失败');
  assert.ok(snap?.summary.finishedAt, '取消也是一次收尾，finishedAt 必须写上');
});

test('取消：正在下载的条目取消后不会再被浏览器事件改回 completed', async () => {
  installChrome();
  const mod = await freshDownloader();
  stub.nextDownload = [{ ok: true, id: 31 }];
  stub.downloads.set(31, {
    id: 31,
    state: 'in_progress',
    bytesReceived: 50,
    totalBytes: 100,
    filename: '1.jpg',
  });

  await mod.startDownloads(undefined, 'task-9', [
    { itemId: 'i1', url: 'https://cdn/x.jpg', filename: '1.jpg', kind: 'image' },
  ]);
  await settle();
  await mod.cancelTask('task-9');

  // 浏览器那边慢半拍：取消之后才把这条报成完成
  stub.downloads.set(31, {
    id: 31,
    state: 'complete',
    bytesReceived: 100,
    totalBytes: 100,
    fileSize: 100,
    filename: '1.jpg',
  });
  await settle(700);

  const snap = mod.getTaskSnapshot('task-9');
  assert.equal(snap?.items[0]?.state, 'cancelled', '取消之后不该被改回「已完成」');
  assert.equal(snap?.summary.completed, 0);
});

/* ------------------------------------------------------------------ */
/* 打包任务的终态                                                        */
/* ------------------------------------------------------------------ */

/** 打包模式：两个文件才会进打包流程（shouldPack 要求多于一个） */
function installZipChrome(): void {
  installChrome();
  stub.settings['rednote.settings'] = { downloadMode: 'zip' };
}

const ZIP_ITEMS = [
  { itemId: 'i1', url: 'https://cdn/1.jpg', filename: '1.jpg', kind: 'image' as const },
  { itemId: 'i2', url: 'https://cdn/2.jpg', filename: '2.jpg', kind: 'image' as const },
];

const PACK = {
  dirName: 'pack-demo',
  name: 'pack-1.zip',
  objectUrl: 'blob:fake',
  downloadPath: '小红书/演示.zip',
};

test('打包：一个都没成功（空包）时任务也要收尾，不能一直挂在下载中', async () => {
  installZipChrome();
  const mod = await freshDownloader();
  await mod.startDownloads(undefined, 'zip-empty', ZIP_ITEMS);
  await settle();

  // 两个文件都下失败了（打包引擎逐条报）
  await mod.handleOffscreenEvent({ type: 'ZIP_ITEM_FAILED', taskId: 'zip-empty', itemId: 'i1', error: 'HTTP 500' });
  await mod.handleOffscreenEvent({ type: 'ZIP_ITEM_FAILED', taskId: 'zip-empty', itemId: 'i2', error: 'HTTP 500' });
  // 打包引擎收工：一个文件都没进包
  await mod.handleOffscreenEvent({ type: 'ZIP_PACKS_READY', taskId: 'zip-empty', packs: [] });
  await settle();

  const snap = mod.getTaskSnapshot('zip-empty');
  assert.equal(snap?.summary.failed, 2);
  assert.ok(snap?.summary.finishedAt, '空包没有收尾：finishedAt 是空的，界面会一直转圈');
});

test('打包：包写出来了但没交给浏览器，任务也要收尾', async () => {
  installZipChrome();
  const mod = await freshDownloader();
  await mod.startDownloads(undefined, 'zip-deliver', ZIP_ITEMS);
  await settle();

  // 交给浏览器时失败（比如文件名非法）
  stub.nextDownload = [{ ok: false, error: 'Invalid filename' }];
  await mod.handleOffscreenEvent({ type: 'ZIP_PACKS_READY', taskId: 'zip-deliver', packs: [PACK] });
  await settle();

  const snap = mod.getTaskSnapshot('zip-deliver');
  assert.equal(snap?.summary.failed, 2, '没交出去的包，里面的文件都要算失败');
  assert.ok(snap?.summary.finishedAt, '交付失败没有收尾：finishedAt 是空的');
});

test('打包：取消之后落到终态，迟到的「包好了」也不会再起下载', async () => {
  installZipChrome();
  const mod = await freshDownloader();
  await mod.startDownloads(undefined, 'zip-cancel', ZIP_ITEMS);
  await settle();

  await mod.cancelTask('zip-cancel');
  const after = mod.getTaskSnapshot('zip-cancel');
  assert.deepEqual(
    after?.items.map((i) => i.state),
    ['cancelled', 'cancelled'],
  );
  assert.ok(after?.summary.finishedAt, '取消之后任务要有终态时间');

  // 后台页面慢半拍：取消之后才把包报上来
  const callsBefore = stub.downloadCalls;
  await mod.handleOffscreenEvent({ type: 'ZIP_PACKS_READY', taskId: 'zip-cancel', packs: [PACK] });
  await settle();

  assert.equal(stub.downloadCalls, callsBefore, '取消之后不该再去下载压缩包');
  assert.deepEqual(
    mod.getTaskSnapshot('zip-cancel')?.items.map((i) => i.state),
    ['cancelled', 'cancelled'],
    '迟到的包不该把条目从「已取消」拉回去',
  );
});

/* ------------------------------------------------------------------ */
/* 收尾的幂等性                                                          */
/* ------------------------------------------------------------------ */

type HistoryRow = { taskId: string; completed: number; finishedAt: number };

function historyRows(taskId: string): HistoryRow[] {
  const all = (stub.settings['rednote.history'] as HistoryRow[] | undefined) ?? [];
  return all.filter((row) => row.taskId === taskId);
}

/** 记录发给页面的 TASK_SUMMARY，用来数「弹了几次完成」 */
function captureSummaries(): Array<{ type: string }> {
  const seen: Array<{ type: string }> = [];
  (globalThis as any).chrome.tabs.sendMessage = async (
    _tabId: number,
    msg: { type?: string },
  ) => {
    if (msg?.type === 'TASK_SUMMARY') seen.push(msg as { type: string });
  };
  return seen;
}

test('收尾：同一任务只写一条历史、只发一次 TASK_SUMMARY', async () => {
  installChrome();
  const mod = await freshDownloader();
  const summaries = captureSummaries();
  stub.nextDownload = [{ ok: true, id: 41 }];
  stub.downloads.set(41, {
    id: 41,
    state: 'in_progress',
    bytesReceived: 10,
    totalBytes: 100,
    filename: '1.jpg',
  });

  await mod.startDownloads(7, 'task-10', [
    { itemId: 'i1', url: 'https://cdn/x.jpg', filename: '1.jpg', kind: 'image' },
  ]);
  await settle();

  stub.downloads.set(41, {
    id: 41,
    state: 'complete',
    bytesReceived: 100,
    totalBytes: 100,
    fileSize: 100,
    filename: '1.jpg',
  });
  // poll 完成后会依次走 pump 和自身两条收尾路径 —— 只能记一次
  await settle(900);

  assert.equal(historyRows('task-10').length, 1, '同一个任务写了多条下载历史');
  assert.equal(summaries.length, 1, '完成提示发了不止一次');
});

test('收尾：取消后重试再完成，历史还是那一条（不会多出一条）', async () => {
  installChrome();
  const mod = await freshDownloader();
  stub.nextDownload = [{ ok: true, id: 51 }];
  stub.downloads.set(51, {
    id: 51,
    state: 'in_progress',
    bytesReceived: 0,
    totalBytes: 100,
    filename: '1.jpg',
  });

  await mod.startDownloads(undefined, 'task-11', [
    { itemId: 'i1', url: 'https://cdn/x.jpg', filename: '1.jpg', kind: 'image' },
  ]);
  await settle();

  await mod.cancelTask('task-11');
  assert.equal(historyRows('task-11').length, 1, '取消时应该已经写了一条历史');

  // 用户点了重试，这次下载成功
  stub.nextDownload = [{ ok: true, id: 52 }];
  stub.downloads.set(52, {
    id: 52,
    state: 'in_progress',
    bytesReceived: 0,
    totalBytes: 100,
    filename: '1.jpg',
  });
  await mod.retryItem('task-11', 'i1');
  await settle();
  stub.downloads.set(52, {
    id: 52,
    state: 'complete',
    bytesReceived: 100,
    totalBytes: 100,
    fileSize: 100,
    filename: '1.jpg',
  });
  await settle(900);

  const rows = historyRows('task-11');
  assert.equal(rows.length, 1, '重试完成之后又插了一条历史');
  assert.equal(rows[0]?.completed, 1, '历史里的完成数没有跟着更新');
  assert.equal(mod.getTaskSnapshot('task-11')?.items[0]?.state, 'completed');
});

/* ------------------------------------------------------------------ */
/* 旧设置迁移                                                            */
/* ------------------------------------------------------------------ */

test('设置迁移：旧版本的 folderByNote:false 迁成「全部平铺」', async () => {
  installChrome();
  stub.settings['rednote.settings'] = { folderByNote: false };
  const mod = await freshDownloader();
  const settings = await mod.getSettings();
  assert.equal(settings.saveStructure, 'flat');
});

test('设置迁移：旧版本的 folderByNote:true 迁成「按笔记」', async () => {
  installChrome();
  stub.settings['rednote.settings'] = { folderByNote: true };
  const mod = await freshDownloader();
  const settings = await mod.getSettings();
  assert.equal(settings.saveStructure, 'perNote');
});

test('设置迁移：已经选了保存结构的老用户不被覆盖', async () => {
  installChrome();
  stub.settings['rednote.settings'] = { saveStructure: 'flat', folderByNote: true };
  const mod = await freshDownloader();
  const settings = await mod.getSettings();
  assert.equal(settings.saveStructure, 'flat', '新字段优先于迁移规则');
});

test('设置迁移：迁移后旧开关不再留在存储里', async () => {
  installChrome();
  stub.settings['rednote.settings'] = { folderByNote: false };
  const mod = await freshDownloader();
  const settings = await mod.getSettings();
  assert.equal('folderByNote' in settings, false);
});

/* ------------------------------------------------------------------ */
/* 历史的顺序                                                          */
/* ------------------------------------------------------------------ */

/** 跑完一个任务：起下载 → 跑完 → 收尾 */
async function runToCompletion(
  mod: any,
  taskId: string,
  downloadId: number,
  itemId = 'i1',
): Promise<void> {
  stub.nextDownload = [{ ok: true, id: downloadId }];
  stub.downloads.set(downloadId, {
    id: downloadId,
    state: 'in_progress',
    bytesReceived: 10,
    totalBytes: 100,
    filename: `${itemId}.jpg`,
  });
  await mod.startDownloads(undefined, taskId, [
    { itemId, url: 'https://cdn/x.jpg', filename: `${itemId}.jpg`, kind: 'image' },
  ]);
  await settle();
  stub.downloads.set(downloadId, {
    id: downloadId,
    state: 'complete',
    bytesReceived: 100,
    totalBytes: 100,
    fileSize: 100,
    filename: `${itemId}.jpg`,
  });
  await settle(900);
}

test('历史：老任务重试完成后会挪到最前（历史按「最近完成」排）', async () => {
  installChrome();
  const mod = await freshDownloader();

  const order = () =>
    ((stub.settings['rednote.history'] as HistoryRow[] | undefined) ?? []).map(
      (row) => row.taskId,
    );

  // task-old：两个文件，一个成功一个失败 —— 这样才有「重试」可点
  // （重试一个已经完成的项是没有意义的，retryItem 会直接忽略）
  stub.nextDownload = [
    { ok: true, id: 71 },
    { ok: false, error: 'SERVER_BAD_CONTENT' },
  ];
  stub.downloads.set(71, {
    id: 71,
    state: 'in_progress',
    bytesReceived: 10,
    totalBytes: 100,
    filename: 'i1.jpg',
  });
  await mod.startDownloads(undefined, 'task-old', [
    { itemId: 'i1', url: 'https://cdn/1.jpg', filename: 'i1.jpg', kind: 'image' },
    { itemId: 'i2', url: 'https://cdn/2.jpg', filename: 'i2.jpg', kind: 'image' },
  ]);
  await settle();
  stub.downloads.set(71, {
    id: 71,
    state: 'complete',
    bytesReceived: 100,
    totalBytes: 100,
    fileSize: 100,
    filename: 'i1.jpg',
  });
  await settle(900);

  assert.deepEqual(order(), ['task-old'], 'task-old 收尾（1 成功 1 失败）');

  // 另一个任务跑完 —— 它排在 task-old 前面
  await runToCompletion(mod, 'task-new', 72);
  assert.deepEqual(order(), ['task-new', 'task-old'], '两个任务都跑完后，后完成的在前');

  // 回头重试 task-old 里失败的那个文件 —— 完成之后它应该又回到最前
  stub.nextDownload = [{ ok: true, id: 73 }];
  await mod.retryItem('task-old', 'i2');
  await settle();
  stub.downloads.set(73, {
    id: 73,
    state: 'complete',
    bytesReceived: 100,
    totalBytes: 100,
    fileSize: 100,
    filename: 'i2.jpg',
  });
  await settle(900);

  assert.deepEqual(order(), ['task-old', 'task-new'], '重试完成的老任务没有被挪到最前');
  assert.equal(historyRows('task-old').length, 1, '还是只有一行');
});

/* ------------------------------------------------------------------ */
/* 取消时清临时产物                                                    */
/* ------------------------------------------------------------------ */

test('取消打包任务：要通知后台页面停手（临时包由它清）', async () => {
  installZipChrome();
  const mod = await freshDownloader();
  await mod.startDownloads(undefined, 'zip-clean', ZIP_ITEMS);
  await settle();

  await mod.cancelTask('zip-clean');
  await settle();

  const types = stub.sentMessages.map((m) => m.type);
  assert.ok(types.includes('ZIP_CANCEL'), '取消时必须让后台页面停下手里的打包');
});

test('打包的压缩包存不下来时：要通知后台页面删掉临时包', async () => {
  installZipChrome();
  const mod = await freshDownloader();
  await mod.startDownloads(undefined, 'zip-broken', ZIP_ITEMS);
  await settle();

  // 包写好了，交给浏览器下载
  stub.nextDownload = [{ ok: true, id: 81 }];
  stub.downloads.set(81, {
    id: 81,
    state: 'in_progress',
    bytesReceived: 10,
    totalBytes: 100,
    filename: 'pack.zip',
  });
  await mod.handleOffscreenEvent({ type: 'ZIP_PACKS_READY', taskId: 'zip-broken', packs: [PACK] });
  await settle();

  // 存到一半失败了
  stub.downloads.set(81, {
    id: 81,
    state: 'interrupted',
    bytesReceived: 10,
    totalBytes: 100,
    error: 'FILE_FAILED',
    filename: 'pack.zip',
  });
  await settle(900);

  const cleanups = stub.sentMessages.filter((m) => m.type === 'ZIP_CLEANUP');
  assert.equal(cleanups.length, 1, '存失败的包留在 OPFS 里没人清');
});
