/**
 * 自研下载引擎：扩展自己取字节、自己写文件。
 *
 * 为什么不用 chrome.downloads：
 *   - 每个文件都会在浏览器里留下一条下载记录，批量时下载栏会被占满；
 *   - 进度只能靠 downloads.search 反推，既慢又不准；
 *   - 实测大文件吞吐只有自己写盘的一半（Chrome 的下载服务多了一层账本和临时文件）。
 *
 * 为什么能自己下：
 *   - 小红书的 CDN 回了 `access-control-allow-origin: *`，
 *     所以扩展在**没有额外 host 权限**的情况下就能 fetch 到字节；
 *   - CDN 支持 `accept-ranges: bytes`，理论上可以断点续传。
 *
 * 关于断点续传：File System Access 的 createWritable() 走的是「临时文件 + 提交」，
 * 数据只在 close() 时才落到目标文件上。也就是说下载中途失败，磁盘上什么都没有，
 * 没法从断点接着写 —— 只能整个重下（和现在的浏览器下载行为一致）。
 * 想真正续传只有 createSyncAccessHandle()，但它仅限 OPFS 的文件，用不了。
 */

/** 引擎抛出的错误：retryable 决定上层要不要自动重试 */
export class SelfDownloadError extends Error {
  readonly retryable: boolean;

  constructor(message: string, retryable: boolean) {
    super(message);
    this.name = 'SelfDownloadError';
    this.retryable = retryable;
  }
}

export interface SelfDownloadOptions {
  /** 用户选定的根目录 */
  root: FileSystemDirectoryHandle;
  /** 相对路径，例如 `小红书下载/昵称/标题/01.jpg` */
  relPath: string;
  /** 媒体直链 */
  url: string;
  /** 取消信号 */
  signal: AbortSignal;
  /** 进度回调（收到字节数 / 总字节数，总数未知时为 -1） */
  onProgress: (received: number, total: number) => void;
}

export interface SelfDownloadResult {
  bytes: number;
  /** 最终落盘的文件名（含目录） */
  path: string;
}

/** 把相对路径拆成「目录段 + 文件名」 */
export function splitRelPath(relPath: string): { dirs: string[]; name: string } {
  const parts = relPath
    .split('/')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const name = parts.pop() ?? 'untitled';
  return { dirs: parts, name };
}

/** 逐层拿到（或创建）子目录 */
async function resolveDir(
  root: FileSystemDirectoryHandle,
  dirs: string[],
): Promise<FileSystemDirectoryHandle> {
  let dir = root;
  for (const segment of dirs) {
    dir = await dir.getDirectoryHandle(segment, { create: true });
  }
  return dir;
}

/**
 * 正在写入中的文件名。
 *
 * 磁盘上「查得到没有」和「真的写进去」之间有缝隙：两个并发下载同名文件时，
 * 都会查到「这个名字还空着」，然后双双写进同一个文件，后一个把前一个冲掉。
 * 小红书上「同一个作者发了同标题的两篇笔记」是很常见的，同一批里就会撞。
 * 所以先在这张表里把名字占住。
 */
const claimedNames = new Set<string>();

/** 根目录句柄的编号：用来区分不同目录下同名的文件 */
const rootIds = new WeakMap<object, number>();
let nextRootId = 1;

function rootId(root: FileSystemDirectoryHandle): number {
  let id = rootIds.get(root);
  if (id === undefined) {
    id = nextRootId;
    nextRootId += 1;
    rootIds.set(root, id);
  }
  return id;
}

/**
 * 找一个没被占用的文件名，**并且立刻把这个名字占住**。
 *
 * 和 Chrome 的 uniquify 行为对齐：`01.jpg` → `01 (1).jpg` → `01 (2).jpg`。
 * 直接覆盖旧文件不行 —— 用户之前下载的内容不能被悄悄冲掉。
 *
 * claimBase 是「目录 + 根目录」的标识，用来跟 claimedNames 对齐。
 *
 * 「占住」这一步必须和「检查」是同一段同步代码：
 * 分成两段的话，两个并发下载会同时查到「这个名字还空着」，
 * 然后双双写进同一个文件，后一个把前一个冲掉。
 */
async function pickFreeName(
  dir: FileSystemDirectoryHandle,
  name: string,
  claimBase: string,
): Promise<string> {
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';

  const candidates = [name];
  for (let i = 1; i < 1000; i += 1) candidates.push(`${stem} (${i})${ext}`);
  // 实在挤不下了就加时间戳，保证不覆盖
  candidates.push(`${stem} ${Date.now()}${ext}`);

  const existsOnDisk = async (candidate: string): Promise<boolean> => {
    try {
      await dir.getFileHandle(candidate);
      return true;
    } catch {
      return false;
    }
  };

  for (const candidate of candidates) {
    const key = `${claimBase}/${candidate}`;
    // 从检查到占住，中间不能有 await —— 否则两个并发下载会同时选中同一个名字
    if (claimedNames.has(key)) continue;
    claimedNames.add(key);

    // 名字已经是我们的了，别人抢不走；再去磁盘上确认一下之前有没有存过
    if (!(await existsOnDisk(candidate))) return candidate;
    claimedNames.delete(key);
  }

  // 理论上到不了这里（1000 个名字都被占了），兜底给个时间戳
  const fallback = `${stem} ${Date.now()}-${Math.random().toString(36).slice(2, 6)}${ext}`;
  claimedNames.add(`${claimBase}/${fallback}`);
  return fallback;
}

/** 5xx / 429 值得重试，4xx（除了 429）重试也没用 */
function isRetryableStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status < 600);
}

/**
 * 下载一个文件到目录。
 *
 * 全程流式：一次只在内存里留一个数据块，几百 MB 的视频也不会把内存吃满。
 */
export async function downloadToFile(opts: SelfDownloadOptions): Promise<SelfDownloadResult> {
  const { root, relPath, url, signal, onProgress } = opts;
  const { dirs, name } = splitRelPath(relPath);

  const dir = await resolveDir(root, dirs);
  const claimBase = `${rootId(root)}:${dirs.join('/')}`;
  // 名字在这里就被占住了（pickFreeName 顺手做的），下载期间别人抢不走
  const fileName = await pickFreeName(dir, name, claimBase);
  const claimKey = `${claimBase}/${fileName}`;

  try {
    return await writeFile({ dir, dirs, fileName, url, signal, onProgress });
  } finally {
    claimedNames.delete(claimKey);
  }
}

/** 把这一轮自己刚建出来的那个文件从磁盘上抹掉 */
async function removeCreatedFile(dir: FileSystemDirectoryHandle, fileName: string): Promise<void> {
  try {
    await dir.removeEntry(fileName);
  } catch {
    /* 删不掉就算了：最坏情况是留一个 0 字节的同名文件 */
  }
}

/**
 * 真正写文件的那一段。
 *
 * 分出来是因为「占住文件名」这件事必须覆盖整个下载过程，
 * 而写文件的失败处理要能自己清理现场。
 */
async function writeFile(args: {
  dir: FileSystemDirectoryHandle;
  dirs: string[];
  fileName: string;
  url: string;
  signal: AbortSignal;
  onProgress: (received: number, total: number) => void;
}): Promise<SelfDownloadResult> {
  const { dir, dirs, fileName, url, signal, onProgress } = args;

  let response: Response;
  try {
    response = await fetch(url, { signal, credentials: 'omit', redirect: 'follow' });
  } catch (err) {
    if (signal.aborted) throw new SelfDownloadError('已取消', false);
    // fetch 的网络层失败一律是 TypeError，属于可以重试的瞬时故障
    throw new SelfDownloadError(
      `网络请求失败：${err instanceof Error ? err.message : String(err)}`,
      true,
    );
  }

  if (!response.ok) {
    throw new SelfDownloadError(
      `服务器返回 ${response.status} ${response.statusText || ''}`.trim(),
      isRetryableStatus(response.status),
    );
  }

  const lengthHeader = response.headers.get('content-length');
  const total = lengthHeader ? Number(lengthHeader) : -1;
  const body = response.body;
  if (!body) {
    throw new SelfDownloadError('服务器没有返回内容', true);
  }

  const fileHandle = await dir.getFileHandle(fileName, { create: true });
  const writable = await fileHandle.createWritable();

  let received = 0;
  try {
    const reader = body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      await writable.write(value);
      received += value.byteLength;
      onProgress(received, total);
    }
    await writable.close();
  } catch (err) {
    // abort 会让临时文件直接作废，目标文件保持原样（不会留半个文件）
    await writable.abort().catch(() => undefined);
    // 但目标文件本身已经建出来了（0 字节）—— 抹掉，
    // 不然下次同名下载会变成「xxx (1).jpg」，而那个 xxx 是空的
    await removeCreatedFile(dir, fileName);
    if (signal.aborted) throw new SelfDownloadError('已取消', false);
    throw new SelfDownloadError(
      `写入失败：${err instanceof Error ? err.message : String(err)}`,
      true,
    );
  }

  // 落盘后回读一次大小：0 字节的「成功」必须当失败，
  // 否则用户以为下好了，硬盘上却什么都没有
  const written = await fileHandle.getFile();
  if (written.size === 0) {
    await removeCreatedFile(dir, fileName);
    throw new SelfDownloadError('下载完成但文件为空，已标记为失败', true);
  }

  onProgress(written.size, total > 0 ? total : written.size);

  return {
    bytes: written.size,
    path: [...dirs, fileName].join('/'),
  };
}
