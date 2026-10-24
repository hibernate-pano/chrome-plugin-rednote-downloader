/**
 * 自研下载引擎的单元测试。
 *
 * 测的是 engine-self.ts：取字节 → 写文件 → 报进度。
 * 这里用内存版的文件系统替身和 fetch 替身，
 * 所以不需要浏览器也能把各种边界情况跑一遍。
 *
 * 运行：npm test
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { downloadToFile, SelfDownloadError, splitRelPath } from '../src/background/engine-self';

/* ------------------------------------------------------------------ */
/* 替身                                                                */
/* ------------------------------------------------------------------ */

interface FakeFile {
  name: string;
  bytes: Uint8Array;
}

class FakeWritable {
  chunks: Uint8Array[] = [];
  closed = false;
  aborted = false;

  constructor(private readonly file: FakeFile) {}

  async write(chunk: Uint8Array): Promise<void> {
    this.chunks.push(chunk);
  }
  async close(): Promise<void> {
    // 真实实现里 close() 才是数据落盘的那一刻
    const total = this.chunks.reduce((n, c) => n + c.length, 0);
    const merged = new Uint8Array(total);
    let at = 0;
    for (const chunk of this.chunks) {
      merged.set(chunk, at);
      at += chunk.length;
    }
    this.file.bytes = merged;
    this.closed = true;
  }
  async abort(): Promise<void> {
    // 真实实现里 abort() 会作废临时文件，目标文件保持原样
    this.aborted = true;
  }
}

class FakeFileHandle {
  readonly kind = 'file';
  writable?: FakeWritable;

  constructor(readonly file: FakeFile) {}

  async createWritable(): Promise<FakeWritable> {
    this.writable = new FakeWritable(this.file);
    return this.writable;
  }

  async getFile(): Promise<{ size: number }> {
    return { size: this.file.bytes.length };
  }
}

class FakeDirHandle {
  readonly kind = 'directory';
  readonly files = new Map<string, FakeFileHandle>();
  readonly dirs = new Map<string, FakeDirHandle>();

  constructor(readonly name: string) {}

  async getDirectoryHandle(
    name: string,
    opts?: { create?: boolean },
  ): Promise<FakeDirHandle> {
    const found = this.dirs.get(name);
    if (found) return found;
    if (!opts?.create) throw new DOMException('NotFoundError');
    const created = new FakeDirHandle(name);
    this.dirs.set(name, created);
    return created;
  }

  async getFileHandle(name: string, opts?: { create?: boolean }): Promise<FakeFileHandle> {
    const found = this.files.get(name);
    if (found) return found;
    if (!opts?.create) throw new DOMException('NotFoundError');
    const file: FakeFile = { name, bytes: new Uint8Array() };
    const handle = new FakeFileHandle(file);
    this.files.set(name, handle);
    return handle;
  }

  async removeEntry(name: string): Promise<void> {
    if (!this.files.delete(name)) throw new DOMException('NotFoundError');
  }
}

/** 递归找某个路径下的文件 */
function findFile(dir: FakeDirHandle, path: string[]): FakeFileHandle | undefined {
  if (path.length === 0) return undefined;
  const [head, ...rest] = path;
  if (rest.length === 0) return dir.files.get(head);
  const sub = dir.dirs.get(head);
  return sub ? findFile(sub, rest) : undefined;
}

function fakeResponse(
  bytes: Uint8Array,
  status = 200,
  headers: Record<string, string> = {},
): unknown {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    headers: { get: (key: string) => headers[key.toLowerCase()] ?? null },
    body: {
      getReader() {
        let at = 0;
        return {
          async read() {
            if (at >= bytes.length) return { done: true, value: undefined };
            const chunk = bytes.slice(at, at + 64);
            at += 64;
            return { done: false, value: chunk };
          },
        };
      },
    },
  };
}

/** 装一个 fetch 替身，返回值由测试给 */
function stubFetch(
  handler: (url: string, init?: RequestInit) => unknown | Promise<unknown>,
): void {
  (globalThis as unknown as { fetch: unknown }).fetch = async (
    url: string,
    init?: RequestInit,
  ) => handler(url, init);
}

function bytesOf(length: number, fill = 7): Uint8Array {
  return new Uint8Array(length).fill(fill);
}

/* ------------------------------------------------------------------ */
/* 用例                                                                */
/* ------------------------------------------------------------------ */

test('engine-self：相对路径拆成目录段和文件名', () => {
  assert.deepEqual(splitRelPath('小红书下载/昵称/标题/01.jpg'), {
    dirs: ['小红书下载', '昵称', '标题'],
    name: '01.jpg',
  });
  assert.deepEqual(splitRelPath('01.jpg'), { dirs: [], name: '01.jpg' });
  assert.deepEqual(splitRelPath('a//b/'), { dirs: ['a'], name: 'b' });
});

test('engine-self：文件内容、目录层级和进度回调都对', async () => {
  const root = new FakeDirHandle('root');
  const payload = bytesOf(200, 9);
  stubFetch(async () => fakeResponse(payload, 200, { 'content-length': '200' }));

  const progress: Array<[number, number]> = [];
  const result = await downloadToFile({
    root: root as unknown as FileSystemDirectoryHandle,
    relPath: '小红书下载/昵称/标题/01.jpg',
    url: 'https://cdn/01.jpg',
    signal: new AbortController().signal,
    onProgress: (received, total) => progress.push([received, total]),
  });

  assert.equal(result.bytes, 200);
  assert.equal(result.path, '小红书下载/昵称/标题/01.jpg');
  // 200 字节按 64 一块 = 4 次数据回调，落盘后再确认一次 = 5 次
  assert.equal(progress.length, 5, '200 字节按 64 一块，应当回调 4 次 + 落盘确认 1 次');
  assert.deepEqual(progress[0], [64, 200]);
  assert.deepEqual(progress[3], [200, 200]);
  assert.deepEqual(progress.at(-1), [200, 200]);

  // 目录真的建出来了
  assert.ok(root.dirs.has('小红书下载'));
  const noteDir = root.dirs.get('小红书下载')!.dirs.get('昵称')!.dirs.get('标题');
  assert.ok(noteDir, '多级目录被逐层创建');
  assert.ok(noteDir.files.has('01.jpg'));
});

test('engine-self：同名文件不会被覆盖，而是加上 (1)', async () => {
  const root = new FakeDirHandle('root');
  stubFetch(async () => fakeResponse(bytesOf(10), 200, { 'content-length': '10' }));

  const opts = {
    root: root as unknown as FileSystemDirectoryHandle,
    relPath: 'a/1.jpg',
    url: 'https://cdn/1.jpg',
    signal: new AbortController().signal,
    onProgress: () => undefined,
  };
  await downloadToFile(opts);
  const second = await downloadToFile(opts);

  assert.equal(second.path, 'a/1 (1).jpg', '第二个文件换了名字');
  assert.equal(findFile(root, ['a', '1.jpg'])?.file.bytes.length, 10, '原来的文件还在');
  assert.equal(findFile(root, ['a', '1 (1).jpg'])?.file.bytes.length, 10);
});

test('engine-self：4xx 不重试，5xx 和网络错误要重试', async () => {
  stubFetch(async () => fakeResponse(new Uint8Array(), 404));
  await assert.rejects(
    () =>
      downloadToFile({
        root: new FakeDirHandle('root') as unknown as FileSystemDirectoryHandle,
        relPath: '1.jpg',
        url: 'https://cdn/1.jpg',
        signal: new AbortController().signal,
        onProgress: () => undefined,
      }),
    (err: unknown) => {
      assert.ok(err instanceof SelfDownloadError);
      assert.equal(err.retryable, false, '404 重试也没用');
      assert.match(err.message, /404/);
      return true;
    },
  );

  stubFetch(async () => fakeResponse(new Uint8Array(), 503));
  await assert.rejects(
    () =>
      downloadToFile({
        root: new FakeDirHandle('root') as unknown as FileSystemDirectoryHandle,
        relPath: '1.jpg',
        url: 'https://cdn/1.jpg',
        signal: new AbortController().signal,
        onProgress: () => undefined,
      }),
    (err: unknown) => {
      assert.ok(err instanceof SelfDownloadError);
      assert.equal(err.retryable, true, '5xx 是瞬时故障，值得重试');
      return true;
    },
  );

  stubFetch(async () => {
    throw new TypeError('Failed to fetch');
  });
  await assert.rejects(
    () =>
      downloadToFile({
        root: new FakeDirHandle('root') as unknown as FileSystemDirectoryHandle,
        relPath: '1.jpg',
        url: 'https://cdn/1.jpg',
        signal: new AbortController().signal,
        onProgress: () => undefined,
      }),
    (err: unknown) => {
      assert.ok(err instanceof SelfDownloadError);
      assert.equal(err.retryable, true, '网络层失败可以重试');
      return true;
    },
  );
});

test('engine-self：0 字节的响应判为失败，不会当成下载成功', async () => {
  const root = new FakeDirHandle('root');
  stubFetch(async () => fakeResponse(new Uint8Array(), 200, { 'content-length': '0' }));
  await assert.rejects(
    () =>
      downloadToFile({
        root: root as unknown as FileSystemDirectoryHandle,
        relPath: '1.jpg',
        url: 'https://cdn/1.jpg',
        signal: new AbortController().signal,
        onProgress: () => undefined,
      }),
    (err: unknown) => {
      assert.ok(err instanceof SelfDownloadError);
      assert.match(err.message, /文件为空/);
      return true;
    },
  );
});

test('engine-self：下载失败不留 0 字节的空文件', async () => {
  const root = new FakeDirHandle('root');
  // 服务器说成功，但一个字节都不给 —— 目标文件已经被建出来了
  stubFetch(async () => fakeResponse(new Uint8Array(), 200, { 'content-length': '0' }));

  await assert.rejects(() =>
    downloadToFile({
      root: root as unknown as FileSystemDirectoryHandle,
      relPath: 'a/1.jpg',
      url: 'https://cdn/1.jpg',
      signal: new AbortController().signal,
      onProgress: () => undefined,
    }),
  );

  // 空文件被抹掉了 —— 不然下一次同名下载会变成「1 (1).jpg」，那个 1 是空的
  assert.equal(findFile(root, ['a', '1.jpg']), undefined, '失败后不留空文件');
});

test('engine-self：并发下载同名文件不会互相覆盖', async () => {
  const root = new FakeDirHandle('root');
  stubFetch(async () => fakeResponse(bytesOf(20), 200, { 'content-length': '20' }));

  const opts = {
    root: root as unknown as FileSystemDirectoryHandle,
    relPath: 'a/1.jpg',
    url: 'https://cdn/1.jpg',
    signal: new AbortController().signal,
    onProgress: () => undefined,
  };
  // 同一批里两个同名文件（同一个作者发了同标题的两篇笔记）
  const [one, two] = await Promise.all([downloadToFile(opts), downloadToFile(opts)]);

  assert.notEqual(one.path, two.path, '两个文件拿到了不同的名字');
  const files = [...(root.dirs.get('a')?.files.values() ?? [])];
  assert.equal(files.length, 2, '两个文件都在磁盘上');
  assert.equal(
    files.every((f) => f.file.bytes.length === 20),
    true,
    '两个文件的内容都是完整的（没有互相覆盖）',
  );
});

test('engine-self：中途取消不会留下半个文件', async () => {
  const controller = new AbortController();
  const root = new FakeDirHandle('root');
  stubFetch(async () => {
    // 真实 fetch 在信号被取消后会直接抛 AbortError
    controller.abort();
    throw new DOMException('The user aborted a request.', 'AbortError');
  });

  await assert.rejects(
    () =>
      downloadToFile({
        root: root as unknown as FileSystemDirectoryHandle,
        relPath: '1.jpg',
        url: 'https://cdn/1.jpg',
        signal: controller.signal,
        onProgress: () => undefined,
      }),
    (err: unknown) => {
      assert.ok(err instanceof SelfDownloadError);
      assert.match(err.message, /已取消/);
      return true;
    },
  );
});
