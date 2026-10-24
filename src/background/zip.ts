/**
 * 极简 ZIP 写入器（只支持「不压缩」）。
 *
 * 为什么不做压缩：我们要打包的是 JPEG / MP4 —— 这两种格式本身就已经压缩过了，
 * 再 deflate 一遍几乎压不动（通常还更大），只是白白烧 CPU、拖慢速度。
 * ZIP 在这里的价值是「把 300 个文件变成 1 个」，不是「把文件变小」。
 *
 * 格式：本地文件头 + 数据 + 中央目录 + 结束记录。
 * 大小和 CRC 要等数据写完才知道，所以先写一个占位的本地头，
 * 写完数据再 seek 回去补上 —— 这样生成的是最通用的那种包
 *（不用「数据描述符」那个变通方案，任何解压工具都能读）。
 */

/* ------------------------------------------------------------------ */
/* CRC32                                                               */
/* ------------------------------------------------------------------ */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
})();

/** 增量算 CRC32（IEEE） */
export function crc32Update(crc: number, chunk: Uint8Array): number {
  let c = (crc ^ 0xffffffff) >>> 0;
  for (let i = 0; i < chunk.length; i += 1) {
    const index = (c ^ (chunk[i] as number)) & 0xff;
    c = ((CRC_TABLE[index] as number) ^ (c >>> 8)) >>> 0;
  }
  return (c ^ 0xffffffff) >>> 0;
}

/* ------------------------------------------------------------------ */
/* 字节工具                                                            */
/* ------------------------------------------------------------------ */

/** ZIP 的时间是 DOS 格式：秒是 2 秒一格 */
function dosDateTime(when: Date): { time: number; date: number } {
  const year = Math.max(1980, when.getFullYear());
  return {
    time: (when.getHours() << 11) | (when.getMinutes() << 5) | (when.getSeconds() >> 1),
    date: ((year - 1980) << 9) | ((when.getMonth() + 1) << 5) | when.getDate(),
  };
}

const LOCAL_HEADER_SIGNATURE = 0x04034b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const EOCD_SIGNATURE = 0x06054b50;
/** 通用位标记的 bit 11：文件名是 UTF-8 */
const FLAG_UTF8 = 0x0800;
/** UNIX 的常规文件权限 0644，放进外部属性里，解压出来的文件权限才对 */
const EXTERNAL_ATTRS_UNIX_0644 = 0x81a40000;

interface LocalHeader {
  nameBytes: Uint8Array;
  time: number;
  date: number;
  crc: number;
  size: number;
}

function buildLocalHeader(h: LocalHeader): Uint8Array {
  const buf = new Uint8Array(30 + h.nameBytes.length);
  const view = new DataView(buf.buffer);
  view.setUint32(0, LOCAL_HEADER_SIGNATURE, true);
  view.setUint16(4, 20, true); // 解压需要的版本
  view.setUint16(6, FLAG_UTF8, true);
  view.setUint16(8, 0, true); // 0 = 不压缩
  view.setUint16(10, h.time, true);
  view.setUint16(12, h.date, true);
  view.setUint32(14, h.crc, true);
  view.setUint32(18, h.size, true); // 压缩后大小（不压缩时 = 原大小）
  view.setUint32(22, h.size, true); // 原始大小
  view.setUint16(26, h.nameBytes.length, true);
  view.setUint16(28, 0, true); // 扩展字段长度
  buf.set(h.nameBytes, 30);
  return buf;
}

interface CentralEntry {
  nameBytes: Uint8Array;
  time: number;
  date: number;
  crc: number;
  size: number;
  offset: number;
}

function buildCentralEntry(e: CentralEntry): Uint8Array {
  const buf = new Uint8Array(46 + e.nameBytes.length);
  const view = new DataView(buf.buffer);
  view.setUint32(0, CENTRAL_SIGNATURE, true);
  view.setUint16(4, 0x031e, true); // 「UNIX + 3.0」
  view.setUint16(6, 20, true);
  view.setUint16(8, FLAG_UTF8, true);
  view.setUint16(10, 0, true);
  view.setUint16(12, e.time, true);
  view.setUint16(14, e.date, true);
  view.setUint32(16, e.crc, true);
  view.setUint32(20, e.size, true);
  view.setUint32(24, e.size, true);
  view.setUint16(28, e.nameBytes.length, true);
  view.setUint16(30, 0, true); // 扩展字段
  view.setUint16(32, 0, true); // 注释
  view.setUint16(34, 0, true); // 起始磁盘
  view.setUint16(36, 0, true); // 内部属性
  view.setUint32(38, EXTERNAL_ATTRS_UNIX_0644, true);
  view.setUint32(42, e.offset, true); // 本地头在文件里的偏移
  buf.set(e.nameBytes, 46);
  return buf;
}

function buildEocd(count: number, cdSize: number, cdOffset: number): Uint8Array {
  const buf = new Uint8Array(22);
  const view = new DataView(buf.buffer);
  view.setUint32(0, EOCD_SIGNATURE, true);
  view.setUint16(4, 0, true);
  view.setUint16(6, 0, true);
  view.setUint16(8, count, true);
  view.setUint16(10, count, true);
  view.setUint32(12, cdSize, true);
  view.setUint32(16, cdOffset, true);
  view.setUint16(20, 0, true); // 注释长度
  return buf;
}

/* ------------------------------------------------------------------ */
/* 写入器                                                              */
/* ------------------------------------------------------------------ */

/** 字节往哪儿写（生产环境是文件，测试里是内存） */
export interface ZipSink {
  write(chunk: Uint8Array): Promise<void>;
  /** 跳到指定位置（回头补本地头要用） */
  seek(position: number): Promise<void>;
  tell(): number;
}

export interface ZipEntry {
  name: string;
  crc: number;
  size: number;
  offset: number;
  time: number;
  date: number;
}

export interface ZipSummary {
  /** 打包了几个文件 */
  entries: number;
  /** 原始内容总字节 */
  bytes: number;
}

const encoder = new TextEncoder();

/**
 * 写一个 ZIP。
 *
 * 用法：
 *   const zip = new ZipWriter(sink);
 *   await zip.addFile('目录/1.jpg', someAsyncIterable);
 *   await zip.finish();
 */
export class ZipWriter {
  private readonly entries: ZipEntry[] = [];
  private offset = 0;
  private contentBytes = 0;

  constructor(private readonly sink: ZipSink) {}

  /** 已经写了多少内容（不含头部，用于判断要不要换新包） */
  get bytes(): number {
    return this.contentBytes;
  }

  /** 已经写了多少字节（含头部与中央目录）—— 就是这个包在磁盘上的大小 */
  get totalBytes(): number {
    return this.offset;
  }

  get count(): number {
    return this.entries.length;
  }

  /**
   * 加一个文件。
   *
   * data 是一段字节流（可以分多次给），边收边算 CRC、边写盘，
   * 所以几百 MB 的视频也不会把内存吃满。
   */
  async addFile(
    name: string,
    data: AsyncIterable<Uint8Array> | Iterable<Uint8Array>,
    when: Date = new Date(),
  ): Promise<number> {
    const nameBytes = encoder.encode(name);
    const { time, date } = dosDateTime(when);
    const headerOffset = this.offset;

    // 先写占位的本地头（crc 和大小等下完才知道）
    const placeholder = buildLocalHeader({ nameBytes, time, date, crc: 0, size: 0 });
    await this.sink.write(placeholder);
    this.offset += placeholder.length;

    let crc = 0;
    let size = 0;
    for await (const chunk of data) {
      if (!chunk || chunk.length === 0) continue;
      crc = crc32Update(crc, chunk);
      size += chunk.length;
      await this.sink.write(chunk);
      this.offset += chunk.length;
    }
    this.contentBytes += size;

    // 回去把 crc 和大小补上（ZIP 允许这么做，解压工具读的是中央目录）
    await this.sink.seek(headerOffset);
    await this.sink.write(buildLocalHeader({ nameBytes, time, date, crc, size }));
    await this.sink.seek(this.offset);

    this.entries.push({ name, crc, size, offset: headerOffset, time, date });
    return size;
  }

  /** 收尾：写中央目录和结束记录 */
  async finish(): Promise<ZipSummary> {
    const cdOffset = this.offset;
    let cdSize = 0;
    for (const entry of this.entries) {
      const buf = buildCentralEntry({ ...entry, nameBytes: encoder.encode(entry.name) });
      await this.sink.write(buf);
      cdSize += buf.length;
    }
    this.offset += cdSize;

    const eocd = buildEocd(this.entries.length, cdSize, cdOffset);
    await this.sink.write(eocd);
    this.offset += eocd.length;

    return { entries: this.entries.length, bytes: this.contentBytes };
  }
}

/**
 * 写进内存的 sink —— 单元测试用，也能用来验证生成的包能不能解开。
 *
 * 语义跟真实的可写流一致：seek 之后写入是「覆盖那一段」，
 * 不是「追加到末尾」。ZIP 写入器回头补本地头就靠这个。
 */
export class MemorySink implements ZipSink {
  private buffer = new Uint8Array(1024);
  private length = 0;
  private position = 0;

  async write(chunk: Uint8Array): Promise<void> {
    this.ensure(this.position + chunk.length);
    this.buffer.set(chunk, this.position);
    this.position += chunk.length;
    this.length = Math.max(this.length, this.position);
  }

  async seek(position: number): Promise<void> {
    this.position = position;
  }

  tell(): number {
    return this.position;
  }

  private ensure(size: number): void {
    if (size <= this.buffer.length) return;
    const next = new Uint8Array(Math.max(size, this.buffer.length * 2));
    next.set(this.buffer.subarray(0, this.length));
    this.buffer = next;
  }

  /** 拼起来的完整内容 */
  toBytes(): Uint8Array {
    return this.buffer.slice(0, this.length);
  }
}
