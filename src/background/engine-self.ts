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
 * 这个根目录能不能用 move() 改名：每个目录记一次，试过就不再试。
 *
 * 值为 false = 浏览器不支持改名，那就退回「直接写最终名字」的老办法。
 */
const moveSupport = new WeakMap<object, boolean>();

/** move() 不支持（或者被浏览器拒绝）时抛这个，用来触发兜底路径 */
class MoveUnsupportedError extends Error {}

/**
 * 找一个没被占用的临时文件名，并且立刻占住。
 *
 * 临时名也是别人可能用的名字（万一有文件就叫「1.jpg.crdownload」呢），
 * 所以磁盘上查一遍、在下载名单里也查一遍。
 */
async function freeTempName(
  dir: FileSystemDirectoryHandle,
  finalName: string,
  claimBase: string,
): Promise<string> {
  for (let i = 0; i < 100; i += 1) {
    const candidate = i === 0 ? `${finalName}.crdownload` : `${finalName}.${i}.crdownload`;
    const key = `${claimBase}/${candidate}`;
    // 从检查到占住，中间不能有 await
    if (claimedNames.has(key)) continue;
    claimedNames.add(key);
    try {
      await dir.getFileHandle(candidate);
    } catch {
      return candidate; // 磁盘上没有这个名字
    }
    claimedNames.delete(key);
  }
  const fallback = `${finalName}.${Date.now()}.crdownload`;
  claimedNames.add(`${claimBase}/${fallback}`);
  return fallback;
}

/** 把一个文件的内容流式复制到另一个文件 */
async function copyOver(
  src: FileSystemFileHandle,
  dest: FileSystemFileHandle,
): Promise<void> {
  const file = await src.getFile();
  const writable = await dest.createWritable();
  try {
    const reader = file.stream().getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      await writable.write(value);
    }
    await writable.close();
  } catch (err) {
    await writable.abort().catch(() => undefined);
    throw err;
  }
}

/**
 * 下载一个文件到目录。
 *
 * 全程流式：一次只在内存里留一个数据块，几百 MB 的视频也不会把内存吃满。
 *
 * 落盘分两步：先写 `名字.crdownload`，下完再改名成最终名字。
 * 这么绕一圈是因为浏览器的写文件机制是「临时文件 + 提交」——
 * 它会在目标文件旁边留一个 `名字.crswap`（Chromium 的实现，我们控制不了），
 * 而目标文件在提交之前一直是 0 字节。直接写最终名字的话，
 * 用户在自己的文件夹里会看到一堆 0 字节的「1.mp4」，像是坏了。
 * 先写临时名再改名，最终名字是「一下子出现」的，
 * 下载中看到的是 `1.mp4.crdownload` —— 和 Chrome 自己下载时一模一样。
 */
export async function downloadToFile(opts: SelfDownloadOptions): Promise<SelfDownloadResult> {
  const { root, relPath, url, signal, onProgress } = opts;
  const { dirs, name } = splitRelPath(relPath);

  const dir = await resolveDir(root, dirs);
  const claimBase = `${rootId(root)}:${dirs.join('/')}`;
  // 名字在这里就被占住了（pickFreeName 顺手做的），下载期间别人抢不走
  const fileName = await pickFreeName(dir, name, claimBase);
  const claimKey = `${claimBase}/${fileName}`;

  // 浏览器不支持改名的话就直接写最终名字（少一次改名，但下载中最终名字是空的）
  if (moveSupport.get(root) === false) {
    try {
      const bytes = await writeFile({ dir, dirs, fileName, url, signal, onProgress });
      return { bytes, path: [...dirs, fileName].join('/') };
    } finally {
      claimedNames.delete(claimKey);
    }
  }

  const tempName = await freeTempName(dir, fileName, claimBase);
  const tempKey = `${claimBase}/${tempName}`;

  try {
    const bytes = await writeFile({ dir, dirs, fileName: tempName, url, signal, onProgress });

    try {
      const finalName = await moveToFinal(dir, tempName, fileName, claimBase);
      return { bytes, path: [...dirs, finalName].join('/') };
    } catch (err) {
      if (!(err instanceof MoveUnsupportedError)) throw err;
      // 这个浏览器不让改名：把已经下好的内容搬到最终名字上，
      // 之后这个目录就都直接写最终名字了
      moveSupport.set(root, false);
      const src = await dir.getFileHandle(tempName);
      const dest = await dir.getFileHandle(fileName, { create: true });
      await copyOver(src, dest);
      await dir.removeEntry(tempName).catch(() => undefined);
      return { bytes, path: [...dirs, fileName].join('/') };
    }
  } finally {
    claimedNames.delete(claimKey);
    claimedNames.delete(tempKey);
  }
}

/**
 * 把临时文件改名成最终名字。
 *
 * 名字被占了（别的程序抢先建了同名文件）就换一个再来，
 * 一直换到成功为止 —— 绝不覆盖用户已有的文件。
 */
async function moveToFinal(
  dir: FileSystemDirectoryHandle,
  tempName: string,
  desiredName: string,
  claimBase: string,
): Promise<string> {
  const handle = await dir.getFileHandle(tempName);
  if (typeof handle.move !== 'function') {
    throw new MoveUnsupportedError('这个浏览器不支持改名');
  }
  const move = handle.move.bind(handle);
  let target = desiredName;

  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await move(target);
      return target;
    } catch (err) {
      const isTaken =
        err instanceof DOMException &&
        (err.name === 'InvalidModificationError' || err.name === 'NotFoundError');
      if (!isTaken) throw new MoveUnsupportedError('这个浏览器不支持改名');
      // 名字被占了：先放开原来占的那个，再挑一个没被占的
      claimedNames.delete(`${claimBase}/${target}`);
      target = await pickFreeName(dir, desiredName, claimBase);
    }
  }
  throw new MoveUnsupportedError('改名一直失败');
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
 *
 * 返回写进去的字节数；最终的文件名由调用方决定（可能是改完名的）。
 */
async function writeFile(args: {
  dir: FileSystemDirectoryHandle;
  dirs: string[];
  fileName: string;
  url: string;
  signal: AbortSignal;
  onProgress: (received: number, total: number) => void;
}): Promise<number> {
  const { dir, fileName, url, signal, onProgress } = args;

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

  return written.size;
}
