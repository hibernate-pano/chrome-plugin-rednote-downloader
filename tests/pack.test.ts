/**
 * 打包引擎的单元测试：一个文件下失败，不能把它后面的文件一起丢掉。
 *
 * packIntoOpfs 跑在后台页面里，依赖 OPFS 和 fetch —— 这里各给一个最小替身：
 *   - navigator.storage.getDirectory()：内存里的目录/文件
 *   - fetch：按 URL 决定成功还是 500
 *
 * 检验方式是**把写出来的 zip 字节解析一遍**：包里有哪几个文件名、
 * 和「下载成功的那些」对不对得上。只断言返回值不够 —— 文件没进包，
 * 返回的 packs 看起来照样正常。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

/* ------------------------------------------------------------------ */
/* OPFS 替身                                                            */
/* ------------------------------------------------------------------ */

class FakeFile {
  bytes = new Uint8Array(0);
  private position = 0;

  /** 与 FileSystemWritableFileStream 用法一致：先 seek 再 write */
  async write(chunk: Uint8Array | ArrayBuffer): Promise<void> {
    const data = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
    const end = this.position + data.byteLength;
    if (end > this.bytes.byteLength) {
      const grown = new Uint8Array(end);
      grown.set(this.bytes, 0);
      this.bytes = grown;
    }
    this.bytes.set(data, this.position);
    this.position = end;
  }

  async seek(position: number): Promise<void> {
    this.position = position;
  }

  async close(): Promise<void> {
    /* 内存文件没有句柄要关 */
  }
}

class FakeDir {
  files = new Map<string, FakeFile>();

  async getFileHandle(name: string): Promise<{
    createWritable: () => Promise<FakeFile>;
  }> {
    const file = this.files.get(name) ?? new FakeFile();
    this.files.set(name, file);
    return { createWritable: async () => file };
  }

  async removeEntry(name: string): Promise<void> {
    this.files.delete(name);
  }

  async *entries(): AsyncGenerator<[string, unknown]> {
    for (const [name] of this.files) yield [name, null];
  }
}

const storageRoot = new FakeDir();

function installBrowserStubs(): void {
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: {
      storage: {
        getDirectory: async () => ({
          getDirectoryHandle: async () => storageRoot,
        }),
      },
    },
  });
}

/** fetch 替身：URL 里带 bad 的返回 500，其余返回一小段内容 */
function installFetchStub(): void {
  globalThis.fetch = (async (input: unknown) => {
    const url = String(input);
    if (url.includes('bad')) {
      return { ok: false, status: 500, headers: { get: () => null }, body: null };
    }
    const data = new TextEncoder().encode(`body-of-${url}`);
    return {
      ok: true,
      status: 200,
      headers: { get: (name: string) => (name === 'content-length' ? String(data.byteLength) : null) },
      body: null,
      arrayBuffer: async () => data.buffer,
    };
  }) as unknown as typeof fetch;
}

/* ------------------------------------------------------------------ */
/* zip 解析（只看中央目录里的文件名）                                    */
/* ------------------------------------------------------------------ */

function zipEntryNames(bytes: Uint8Array): string[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= 0; i -= 1) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  assert.ok(eocd >= 0, '写出来的不是合法 zip：找不到结束记录');

  const count = view.getUint16(eocd + 10, true);
  const cdOffset = view.getUint32(eocd + 16, true);
  const decoder = new TextDecoder();
  const names: string[] = [];
  let at = cdOffset;
  for (let i = 0; i < count; i += 1) {
    assert.equal(view.getUint32(at, true), 0x02014b50, '中央目录项签名不对');
    const nameLen = view.getUint16(at + 28, true);
    const extraLen = view.getUint16(at + 30, true);
    const commentLen = view.getUint16(at + 32, true);
    names.push(decoder.decode(bytes.subarray(at + 46, at + 46 + nameLen)));
    at += 46 + nameLen + extraLen + commentLen;
  }
  return names;
}

/** 找到本次任务目录里唯一的那个包，把字节读出来 */
function packBytes(dirName: string): { name: string; bytes: Uint8Array } {
  // 每次用例前目录被 packIntoOpfs 自己的清场逻辑清空，只剩这一次写的包
  const entries = [...storageRoot.files.entries()];
  assert.equal(entries.length, 1, `应该只写出一个包，实际 ${entries.length} 个`);
  const [name, file] = entries[0]!;
  return { name, bytes: file.bytes };
}

const item = (id: string, url: string) => ({
  itemId: id,
  url,
  path: `${id}.jpg`,
});

/* ------------------------------------------------------------------ */
/* 用例                                                                 */
/* ------------------------------------------------------------------ */

test('打包：中间一个文件 500，后面的文件照样要进包', async () => {
  installBrowserStubs();
  installFetchStub();
  const { packIntoOpfs } = await import('../src/offscreen/pack');

  const result = await packIntoOpfs({
    items: [
      item('a', 'https://cdn/a.jpg'),
      item('b', 'https://cdn/bad.jpg'),
      item('c', 'https://cdn/c.jpg'),
    ],
    dirName: 'pack-failure-gap',
    concurrency: 2,
    maxZipBytes: 64 * 1024 * 1024,
    signal: new AbortController().signal,
  });

  // 失败的那条要报出来，成功的两条要真的在包里
  assert.deepEqual(
    result.failed.map((f) => f.itemId),
    ['b'],
    '失败的文件要被报出来',
  );
  assert.equal(result.packs.length, 1, '应该只写一个包');
  const { bytes } = packBytes('pack-failure-gap');
  assert.deepEqual(zipEntryNames(bytes), ['a.jpg', 'c.jpg'], '失败项之后的文件被丢掉了');
  assert.equal(result.packs[0]?.entries, 2);
});

test('打包：全部成功时包里的顺序与下载完成顺序无关', async () => {
  installBrowserStubs();
  installFetchStub();
  const { packIntoOpfs } = await import('../src/offscreen/pack');

  const result = await packIntoOpfs({
    items: [
      item('x', 'https://cdn/x.jpg'),
      item('y', 'https://cdn/y.jpg'),
      item('z', 'https://cdn/z.jpg'),
    ],
    dirName: 'pack-all-ok',
    concurrency: 3,
    maxZipBytes: 64 * 1024 * 1024,
    signal: new AbortController().signal,
  });

  assert.deepEqual(result.failed, []);
  assert.deepEqual(zipEntryNames(packBytes('pack-all-ok').bytes), ['x.jpg', 'y.jpg', 'z.jpg']);
  assert.equal(result.packs[0]?.entries, 3);
});
