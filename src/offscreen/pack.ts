/**
 * 打包引擎：把几百个文件打成一个 zip。
 *
 * 为什么值得打包：
 * 逐个文件落盘，浏览器和系统都要处理几百次 —— 几百条下载记录、
 * 几百次建文件、几百次目录变更通知。文件一多，机器就会明显变卡，
 * 甚至因为同时打开的文件句柄太多而报错。
 * 打成 1 个包，系统只需要处理 1 个文件，这是数量级上的差别。
 *
 * 为什么不压缩：
 * JPEG / MP4 本身就已经压缩过，再 deflate 一遍几乎压不动（通常还更大），
 * 只是白白烧 CPU、拖慢速度。zip 在这里的价值是「1 个文件代替 300 个」。
 *
 * 内存占用：
 * 下载是并行的（网络是瓶颈），但 zip 是顺序结构，写入必须串行。
 * 所以每个下载线程先把文件收进内存，写入线程按顺序取走。
 * 峰值内存 ≈ 并发数 × 单个文件大小。几百兆的视频配 3 个并发是可控的。
 */

import { ZipWriter, type ZipSink } from '../background/zip';

/** 待打包的一个文件 */
export interface PackItem {
  itemId: string;
  url: string;
  /** 包内的相对路径，例如「昵称/标题/1.mp4」 */
  path: string;
  /** 已知的大小（字节），未知时 undefined */
  size?: number;
}

export interface PackOptions {
  items: PackItem[];
  /** 这个任务的私有目录名（不同任务互不干扰） */
  dirName: string;
  /** 并发下载数 */
  concurrency: number;
  /** 单个包的上限（字节），超过就换新包 */
  maxZipBytes: number;
  signal: AbortSignal;
  /** 下载进度（字节） */
  onItemProgress?: (itemId: string, received: number, total: number) => void;
  /** 某个文件打包完成 */
  onItemDone?: (itemId: string, bytes: number) => void;
  /** 某个文件失败 */
  onItemFailed?: (itemId: string, error: string) => void;
}

/** 打好的一个包 */
export interface PackFile {
  /** 在扩展私有文件系统（OPFS）里的名字 */
  name: string;
  /** 内容总字节 */
  bytes: number;
  /** 装了几个文件 */
  entries: number;
}

export interface PackResult {
  packs: PackFile[];
  failed: { itemId: string; error: string }[];
}

/* ------------------------------------------------------------------ */
/* OPFS 里的写入器                                                     */
/* ------------------------------------------------------------------ */

/**
 * 把 zip 写到扩展的私有文件系统（OPFS）。
 *
 * 为什么先写 OPFS 再交给浏览器：
 *  - OPFS 在磁盘上，几十上百兆的包不会把内存吃满；
 *  - OPFS 属于扩展自己，Service Worker 和后台页面都能读写；
 *  - 最后由浏览器把它当成一次普通下载存到用户的下载目录。
 */
class OpfsSink implements ZipSink {
  private position = 0;

  constructor(private readonly stream: FileSystemWritableFileStream) {}

  async write(chunk: Uint8Array): Promise<void> {
    // TS 的 DOM 类型要求底层是普通 ArrayBuffer（不能是 SharedArrayBuffer），
    // 而我们的 Uint8Array 一定满足 —— 这里只是把类型说清楚。
    await this.stream.write(chunk as unknown as BufferSource);
    this.position += chunk.byteLength;
  }

  async seek(position: number): Promise<void> {
    await this.stream.seek(position);
    this.position = position;
  }

  tell(): number {
    return this.position;
  }
}

/* ------------------------------------------------------------------ */
/* 顺序队列                                                            */
/* ------------------------------------------------------------------ */

/**
 * 按序号取数据的队列。
 *
 * 下载完成的顺序是乱的，但包里的文件要按用户勾选的顺序排 ——
 * 所以下载线程按序号存进来，写入线程按序号取走。
 */
class OrderedQueue<T> {
  private readonly buffer = new Map<number, T>();
  private waiters: Array<(value: T | null) => void> = [];
  private next = 0;
  private closed = false;

  push(index: number, value: T): void {
    this.buffer.set(index, value);
    this.pump();
  }

  close(): void {
    this.closed = true;
    this.pump();
  }

  private pump(): void {
    while (this.waiters.length > 0) {
      const hit = this.buffer.get(this.next);
      if (hit === undefined) {
        if (this.closed) {
          const waiter = this.waiters.shift();
          waiter?.(null);
        }
        return;
      }
      this.buffer.delete(this.next);
      this.next += 1;
      const waiter = this.waiters.shift();
      waiter?.(hit);
    }
  }

  async take(): Promise<T | null> {
    const hit = this.buffer.get(this.next);
    if (hit !== undefined) {
      this.buffer.delete(this.next);
      this.next += 1;
      return hit;
    }
    if (this.closed) return null;
    return new Promise<T | null>((resolve) => {
      this.waiters.push(resolve);
    });
  }
}

/* ------------------------------------------------------------------ */
/* 打包                                                                */
/* ------------------------------------------------------------------ */

interface Downloaded {
  item: PackItem;
  data: Uint8Array;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** 把一个文件取回来，边下边报进度 */
async function download(
  item: PackItem,
  signal: AbortSignal,
  onProgress?: (received: number, total: number) => void,
): Promise<Uint8Array> {
  const response = await fetch(item.url, { signal, credentials: 'omit' });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);

  const header = Number(response.headers.get('content-length'));
  const total = header > 0 ? header : (item.size ?? -1);

  const body = response.body;
  if (!body) {
    const data = new Uint8Array(await response.arrayBuffer());
    onProgress?.(data.byteLength, total > 0 ? total : data.byteLength);
    return data;
  }

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    chunks.push(value);
    received += value.byteLength;
    onProgress?.(received, total);
  }

  const data = new Uint8Array(received);
  let at = 0;
  for (const chunk of chunks) {
    data.set(chunk, at);
    at += chunk.byteLength;
  }
  return data;
}

/**
 * 把所有文件打成 zip，写进扩展的私有文件系统。
 *
 * 超过 maxZipBytes 就分成多个包（文件名带序号）——
 * 标准 zip 单个文件上限 4GB，不分包的话几百个视频很容易超。
 */
export async function packIntoOpfs(options: PackOptions): Promise<PackResult> {
  const { items, signal } = options;
  const concurrency = Math.max(1, Math.min(8, options.concurrency));
  const maxZipBytes = Math.max(64 * 1024 * 1024, options.maxZipBytes);

  if (items.length === 0) return { packs: [], failed: [] };

  const root = await navigator.storage.getDirectory();
  // 每个任务一个自己的目录：两个标签页同时打包时不会互相删文件
  const dir = await root.getDirectoryHandle(options.dirName, { create: true });
  // 上一次留下的残骸先清掉，别把旧的包也交出去
  const stale: string[] = [];
  for await (const [name] of dir.entries()) stale.push(name);
  for (const name of stale) {
    try {
      await dir.removeEntry(name);
    } catch {
      /* ignore */
    }
  }

  const queue = new OrderedQueue<Downloaded>();
  const failed: PackResult['failed'] = [];
  const packs: PackFile[] = [];

  let cursor = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      if (signal.aborted) return;
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      const item = items[index];
      if (!item) return;
      try {
        const data = await download(item, signal, (received, total) =>
          options.onItemProgress?.(item.itemId, received, total),
        );
        queue.push(index, { item, data });
      } catch (err) {
        if (signal.aborted) return;
        const message = errorText(err);
        failed.push({ itemId: item.itemId, error: message });
        options.onItemFailed?.(item.itemId, message);
      }
    }
  };

  const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => worker());
  // 下载线程全部结束后，队列里不会再有新东西 —— 把队列关掉，
  // 写入线程才知道「没有下一个了」，可以收工打包。
  // （少了这一步，写入线程会一直等一个永远不来的文件。）
  void Promise.allSettled(workers).then(() => queue.close());

  // 写入线程：按顺序把文件塞进包里
  let writer: ZipWriter | undefined;
  let stream: FileSystemWritableFileStream | undefined;
  let packIndex = 0;

  const openPack = async (): Promise<void> => {
    const name = `pack-${packIndex + 1}.zip`;
    const handle = await dir.getFileHandle(name, { create: true });
    stream = await handle.createWritable();
    writer = new ZipWriter(new OpfsSink(stream));
  };

  const closePack = async (): Promise<void> => {
    if (!writer || !stream) return;
    const summary = await writer.finish();
    const bytes = writer.totalBytes;
    await stream.close();
    packs.push({ name: `pack-${packIndex + 1}.zip`, bytes, entries: summary.entries });
    writer = undefined;
    stream = undefined;
    packIndex += 1;
  };

  try {
    for (;;) {
      const entry = await queue.take();
      if (!entry) break;
      if (signal.aborted) break;

      if (!writer) await openPack();

      // 体积上限：装不下就收尾开新包（zip 单文件上限 4GB）
      const current = writer;
      if (!current) break;
      if (current.count > 0 && current.bytes + entry.data.byteLength > maxZipBytes) {
        await closePack();
        await openPack();
      }

      const target = writer;
      if (!target) break;
      await target.addFile(entry.item.path, [entry.data]);
      options.onItemDone?.(entry.item.itemId, entry.data.byteLength);
    }
  } finally {
    queue.close();
    await Promise.allSettled(workers);
  }

  if (writer) await closePack();

  return { packs, failed };
}

/** 删掉 OPFS 里的临时包（省磁盘） */
export async function removePack(dirName: string, packName: string): Promise<void> {
  try {
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle(dirName);
    await dir.removeEntry(packName);
  } catch {
    /* ignore */
  }
}
