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
}

const sessionStore: Record<string, unknown> = {};

/** 桩的状态：下一次 download() 干什么、search() 返回什么 */
const stub = {
  nextDownload: [] as Array<{ ok: true; id: number } | { ok: false; error: string }>,
  downloads: new Map<number, FakeDownload>(),
  nextId: 1,
  settings: {} as Record<string, unknown>,
};

function installChrome(): FakeChrome {
  // 这些用例测的是「交给浏览器下载」那条路径，
  // 所以把下载方式显式设成 browser（默认是扩展自己写盘）。
  stub.settings['rednote.settings'] = { downloadMode: 'browser' };
  const fake: FakeChrome = {
    downloads: {
      download: async () => {
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
    runtime: { sendMessage: async () => undefined },
    tabs: { sendMessage: async () => undefined },
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
