/**
 * ZIP 写入器的单元测试。
 *
 * 这个格式不能出错 —— 包一旦解不开，用户几百个文件全白下了。
 * 所以这里不只测「能写出来」，还把写出来的字节按规范解析一遍：
 * 本地头、中央目录、结束记录三处的大小与 CRC 都要对得上。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { MemorySink, ZipWriter, crc32Update } from '../src/background/zip';

/** 按规范解析一个 zip，返回每个条目的信息与内容 */
function parseZip(bytes: Uint8Array): {
  entries: { name: string; crc: number; size: number; data: Uint8Array; offset: number }[];
  commentLength: number;
} {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  // 从尾部找结束记录（EOCD）
  let eocd = -1;
  for (let i = bytes.length - 22; i >= 0; i -= 1) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  assert.ok(eocd >= 0, '找不到结束记录');

  const count = view.getUint16(eocd + 10, true);
  const cdSize = view.getUint32(eocd + 12, true);
  const cdOffset = view.getUint32(eocd + 16, true);
  const commentLength = view.getUint16(eocd + 20, true);
  assert.equal(cdOffset + cdSize, eocd, '中央目录应该紧挨着结束记录');

  const decoder = new TextDecoder();
  const entries: { name: string; crc: number; size: number; data: Uint8Array; offset: number }[] = [];

  let at = cdOffset;
  for (let i = 0; i < count; i += 1) {
    assert.equal(view.getUint32(at, true), 0x02014b50, '中央目录项的签名不对');
    const method = view.getUint16(at + 10, true);
    assert.equal(method, 0, '我们只写「不压缩」');
    const crc = view.getUint32(at + 16, true);
    const size = view.getUint32(at + 24, true);
    const nameLen = view.getUint16(at + 28, true);
    const extraLen = view.getUint16(at + 30, true);
    const commentLen = view.getUint16(at + 32, true);
    const offset = view.getUint32(at + 42, true);
    const name = decoder.decode(bytes.subarray(at + 46, at + 46 + nameLen));

    // 本地头必须能对上
    assert.equal(view.getUint32(offset, true), 0x04034b50, '本地头签名不对');
    const localNameLen = view.getUint16(offset + 26, true);
    const localExtraLen = view.getUint16(offset + 28, true);
    const localName = decoder.decode(
      bytes.subarray(offset + 30, offset + 30 + localNameLen),
    );
    assert.equal(localName, name, '本地头与中央目录里的文件名不一致');
    const dataStart = offset + 30 + localNameLen + localExtraLen;
    const data = bytes.subarray(dataStart, dataStart + size);

    entries.push({ name, crc, size, data, offset });
    at += 46 + nameLen + extraLen + commentLen;
  }

  return { entries, commentLength };
}

/** 算一段字节的 CRC32（跟写入器独立实现一遍，避免自己验自己） */
function referenceCrc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

const encoder = new TextEncoder();

test('zip：一个文件写出来能被解析，内容一字不差', async () => {
  const sink = new MemorySink();
  const zip = new ZipWriter(sink);
  const content = encoder.encode('hello 小红书');

  await zip.addFile('a.txt', [content]);
  const summary = await zip.finish();

  assert.equal(summary.entries, 1);
  assert.equal(summary.bytes, content.length);

  const { entries } = parseZip(sink.toBytes());
  assert.equal(entries.length, 1);
  assert.equal(entries[0]?.name, 'a.txt');
  assert.equal(entries[0]?.size, content.length);
  assert.deepEqual(Array.from(entries[0]?.data ?? []), Array.from(content));
  assert.equal(entries[0]?.crc, referenceCrc32(content));
});

test('zip：多个文件按顺序排列，路径原样保留', async () => {
  const sink = new MemorySink();
  const zip = new ZipWriter(sink);

  const files = [
    { name: '昵称/标题一/1.mp4', body: encoder.encode('AAAA') },
    { name: '昵称/标题二/2.jpg', body: encoder.encode('BBBBBB') },
    { name: '昵称/标题二/3.jpg', body: encoder.encode('C') },
  ];
  for (const file of files) await zip.addFile(file.name, [file.body]);
  await zip.finish();

  const { entries } = parseZip(sink.toBytes());
  assert.equal(entries.length, 3);
  assert.deepEqual(
    entries.map((e) => e.name),
    files.map((f) => f.name),
  );
  for (const [i, entry] of entries.entries()) {
    const file = files[i];
    assert.ok(file);
    assert.deepEqual(Array.from(entry.data), Array.from(file.body));
    assert.equal(entry.crc, referenceCrc32(file.body));
  }
});

test('zip：文件名是 UTF-8，解压工具能读出中文', async () => {
  const sink = new MemorySink();
  const zip = new ZipWriter(sink);
  await zip.addFile('小美爱拍照/周末京都｜红叶季/01.jpg', [encoder.encode('x')]);
  await zip.finish();

  const { entries } = parseZip(sink.toBytes());
  assert.equal(entries[0]?.name, '小美爱拍照/周末京都｜红叶季/01.jpg');
});

test('zip：分片写入的内容和一次性写入完全一样', async () => {
  const whole = encoder.encode('0123456789');
  const a = new MemorySink();
  const zipA = new ZipWriter(a);
  await zipA.addFile('x.bin', [whole]);
  await zipA.finish();

  const b = new MemorySink();
  const zipB = new ZipWriter(b);
  await zipB.addFile('x.bin', [whole.subarray(0, 4), whole.subarray(4)]);
  await zipB.finish();

  assert.deepEqual(Array.from(a.toBytes()), Array.from(b.toBytes()));
});

test('zip：空文件也能进包（大小为 0，CRC 为 0）', async () => {
  const sink = new MemorySink();
  const zip = new ZipWriter(sink);
  await zip.addFile('空.txt', []);
  await zip.finish();

  const { entries } = parseZip(sink.toBytes());
  assert.equal(entries.length, 1);
  assert.equal(entries[0]?.size, 0);
  assert.equal(entries[0]?.crc, 0);
});

test('zip：CRC32 跟参考实现一致', () => {
  const data = encoder.encode('The quick brown fox jumps over the lazy dog');
  assert.equal(crc32Update(0, data), referenceCrc32(data));
});

test('zip：totalBytes 是包在磁盘上的总大小（含头部）', async () => {
  const sink = new MemorySink();
  const zip = new ZipWriter(sink);
  const body = encoder.encode('x'.repeat(100));
  await zip.addFile('a.bin', [body]);
  await zip.finish();
  assert.equal(zip.totalBytes, sink.toBytes().length);
  assert.ok(zip.totalBytes > body.length, '总大小应该比内容大（还有头部和中央目录）');
});
