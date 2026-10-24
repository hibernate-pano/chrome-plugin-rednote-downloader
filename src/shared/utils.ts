/** 通用工具：文件名清洗、体积/速度格式化、URL 归一化 */

import type { MediaFilter, MediaKind, SaveStructure, Settings } from './types';

/**
 * 文件类型筛选。
 *
 * 「全部」放行一切；「视频」/「图片」按文件的实际类型判定 ——
 * 视频笔记的封面本身就是一个图片项，所以它归「图片」，
 * 「只下载视频」时会被跳过（否则用户会莫名多收一堆封面 jpg）。
 */
export function matchesMediaFilter(kind: MediaKind, filter: MediaFilter): boolean {
  if (filter === 'all') return true;
  return kind === filter;
}

/** 按文件类型筛选一批媒体项 */
export function filterByMediaFilter<T extends { kind: MediaKind }>(
  items: T[],
  filter: MediaFilter,
): T[] {
  return items.filter((item) => matchesMediaFilter(item.kind, filter));
}

/** 文件类型筛选的中文名 */
export function mediaFilterLabel(filter: MediaFilter): string {
  if (filter === 'video') return '视频';
  if (filter === 'image') return '图片';
  return '全部';
}

/**
 * 保存结构的短标签 —— 面板上的页签、设置页的作用域标签都用它。
 *
 * 三个页签并排，面板只有 360px 宽，标签必须短。
 * 统一用「按什么分组」的角度命名，用户一眼就知道文件会怎么分堆。
 */
export function saveStructureLabel(structure: SaveStructure): string {
  if (structure === 'flat') return '全部平铺';
  if (structure === 'perAuthor') return '按作者';
  return '按笔记';
}

/** 保存结构的长名称 —— 说明文字、页脚、toast 用它 */
export function saveStructureName(structure: SaveStructure): string {
  if (structure === 'flat') return '全部平铺';
  if (structure === 'perAuthor') return '按作者分文件夹';
  return '独立文件夹';
}

/** 切换保存结构时给用户的一句话说明（说清楚落盘长什么样） */
export const SAVE_STRUCTURE_HINTS: Record<SaveStructure, string> = {
  perNote: '每篇笔记一个文件夹：作者/标题/文件名',
  perAuthor: '同一作者的内容放一个文件夹：作者/文件名',
  flat: '所有文件平铺在主文件夹里，文件名里会带作者与标题',
};

/**
 * 当前保存结构对应的命名模板。
 *
 * 三种结构对模板的要求不一样：
 *   - 独立文件夹：目录里已经有「作者/标题」，文件名用序号就够（默认 `{index}`）
 *   - 按作者分文件夹：目录里已经有作者，文件名得带上标题才能区分不同笔记
 *     （默认 `{title}_{index}`）
 *   - 全部平铺：文件名是唯一的身份标识，必须带作者与标题
 *     （默认 `{author}_{title}_{index}`，否则一堆文件都叫 1.mp4）
 */
export function effectiveTemplate(settings: Settings): string {
  if (settings.saveStructure === 'flat') {
    return settings.flatFileNameTemplate || DEFAULT_FLAT_TEMPLATE;
  }
  if (settings.saveStructure === 'perAuthor') {
    return settings.perAuthorFileNameTemplate || DEFAULT_PER_AUTHOR_TEMPLATE;
  }
  return settings.fileNameTemplate || '{index}';
}

const DEFAULT_FLAT_TEMPLATE = '{author}_{title}_{index}';
const DEFAULT_PER_AUTHOR_TEMPLATE = '{title}_{index}';

/**
 * 非法文件名字符。
 *
 * 依据 Chromium 的 net::IsSafePortableRelativePath：
 * 跨平台统一拒绝 `: * ? " < > |`、控制字符（\p{Cc}）和格式字符（\p{Cf}）。
 * 注意这不是「替换成 _」就完事 —— 只要文件名里还剩一个非法字符，
 * chrome.downloads.download() 整个调用就会以 "Invalid filename" 直接失败。
 */
const ILLEGAL_FILENAME_CHARS = /[\\/:*?"<>|]/g;

/** 控制字符（\p{Cc}）：换行、制表符、NUL 等 */
const CONTROL_CHARS = /\p{Cc}/gu;

/**
 * Unicode 格式字符（\p{Cf}）：零宽空格、方向控制符、BOM 等。
 * Chromium 的 IsSafePortableRelativePath 会直接拒绝它们，小红书标题里并不少见，必须清掉。
 */
const FORMAT_CHARS = /\p{Cf}/gu;

/** 变体选择符（U+FE00–U+FE0F、U+E0100–U+E01EF）：对文件名没有任何意义，清掉更干净 */
const VARIATION_SELECTORS = /[\uFE00-\uFE0F\u{E0100}-\u{E01EF}]/gu;

const WINDOWS_RESERVED =
  /^(con|prn|aux|nul|com[1-9]|lpt[1-9]|clock\$|conin\$|conout\$)$/i;

/**
 * Shell 集成扩展名 —— 这几个扩展名能被系统当快捷方式执行，Chromium 一律拒绝。
 * 实测只有 .url / .lnk / .scf / .local 会被拒（.ade / .adp 反而能用，
 * 跟文档里流传的清单不一样，所以以实测为准）。
 * 判据是「最后一个点之后的扩展名」，所以 "foo.url" 被拒、"foo.url.jpg" 能用。
 */
const SHELL_INTEGRATION_EXTS = new Set(['url', 'lnk', 'scf', 'local']);

/**
 * 清洗文本部分：去格式字符、替换非法字符、压缩空白、去前导点、去结尾点与空格。
 * 路径段与文件词干共用这一套，区别只在扩展名的处理。
 */
function cleanText(input: string): string {
  return (input ?? '')
    .replace(FORMAT_CHARS, '')
    .replace(VARIATION_SELECTORS, '')
    .replace(CONTROL_CHARS, '_')
    .replace(ILLEGAL_FILENAME_CHARS, '_')
    .replace(/\s+/g, ' ')
    .trim()
    // 前导点：Chromium 拒绝任何以 . 开头的路径段（".隐藏文件"、".foo.bar" 都不行）
    .replace(/^\.+/, '')
    // 结尾的点与空格：Chromium 拒绝
    .replace(/[.\s]+$/, '');
}

/** 截断到 maxLength 个码点（保留完整代理对），并保证截断后仍然合法 */
function truncate(name: string, maxLength: number): string {
  if (Array.from(name).length <= maxLength) return name;
  let cut = Array.from(name).slice(0, Math.max(1, maxLength)).join('');
  // 截断可能把结尾的点/空格又露出来，也可能切出一个新的前导点
  cut = cut.replace(/[.\s]+$/, '').replace(/^\.+/, '');
  return cut;
}

/** 保留设备名检查：只看第一个点之前那段 */
function hasReservedHead(name: string): boolean {
  const dot = name.indexOf('.');
  const head = dot === -1 ? name : name.slice(0, dot);
  return WINDOWS_RESERVED.test(head);
}

/**
 * 清洗文件名词干（不含扩展名）。
 * 保留设备名加 "_" 前缀 —— "con" → "_con"，Windows 和 Chromium 都认。
 */
export function sanitizeStem(input: string, maxLength = 80): string {
  let name = cleanText(input);
  if (!name) name = 'untitled';
  if (hasReservedHead(name)) name = `_${name}`;
  return truncate(name, maxLength);
}

/** 清洗单个路径段（目录名，或本身就是完整文件名） */
export function sanitizeSegment(input: string, maxLength = 80): string {
  let name = cleanText(input);
  if (!name) name = 'untitled';
  if (hasReservedHead(name)) name = `_${name}`;

  // Shell 集成扩展名：目录名 "我的收藏.url" 会被 Chromium 整个拒掉，
  // 只能把这个扩展名摘掉。文件名的扩展名由 buildFileName 统一处理，不走这里。
  const dot = name.lastIndexOf('.');
  if (dot > 0 && SHELL_INTEGRATION_EXTS.has(name.slice(dot + 1).toLowerCase())) {
    name = name.slice(0, dot);
  }
  if (!name) name = 'untitled';

  return truncate(name, maxLength);
}

/** 拆出词干与扩展名（按最后一个点；没有点或点在前导位置时扩展名为空） */
export function splitExtension(name: string): { stem: string; ext: string } {
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return { stem: name, ext: '' };
  return { stem: name.slice(0, dot), ext: name.slice(dot + 1) };
}

/**
 * 拼一个保证合法的文件名：词干清洗 + 截断 + 指定扩展名。
 *
 * 关键在于「截断只作用于词干」—— 直接截断整个文件名会把 ".jpg" 砍成 ".jp"，
 * 用户拿到的就是一个打不开的文件。
 */
export function buildSafeFileName(stem: string, ext: string, maxLength = 80): string {
  const rawExt = (ext ?? '').replace(/^\.+/, '').toLowerCase();
  if (!rawExt) return sanitizeStem(stem, maxLength);
  // 扩展名也走一遍清洗：万一上游塞进来一个 .url，整个下载调用会直接失败
  const safeExt = sanitizeSegment(rawExt, 10);
  if (!safeExt || SHELL_INTEGRATION_EXTS.has(safeExt.toLowerCase())) {
    return sanitizeStem(stem, maxLength);
  }
  const budget = Math.max(1, maxLength - safeExt.length - 1);
  const safeStem = sanitizeStem(stem, budget);
  return finalizeFileName(`${safeStem}.${safeExt}`);
}

/**
 * 收尾检查：Chromium 看的是「最后一个点之后的扩展名」，
 * 所以拼完之后还得再确认一遍（模板里 {ext} 后面可能又跟了别的字）。
 */
export function finalizeFileName(name: string): string {
  let out = name;
  const dot = out.lastIndexOf('.');
  if (dot > 0 && SHELL_INTEGRATION_EXTS.has(out.slice(dot + 1).toLowerCase())) {
    out = out.slice(0, dot);
  }
  if (hasReservedHead(out)) out = `_${out}`;
  // 前导点与结尾的点/空格 Chromium 都拒绝
  out = out.replace(/^\.+/, '').replace(/[.\s]+$/, '');
  return out || 'untitled';
}

/** 清洗一整条相对路径，逐段处理 */
export function sanitizeRelativePath(input: string): string {
  return input
    .split('/')
    .filter((s) => s.trim().length > 0)
    .map((s) => sanitizeSegment(s))
    .join('/');
}

/**
 * 填一个占位符。
 *
 * 值为空时，把占位符连同紧邻的一个分隔符一起去掉 ——
 * 否则「{author}_{title}_{index}」遇到空标题会变成「小美__1.mp4」这种双下划线。
 */
function fillToken(template: string, token: string, value: string): string {
  if (value) return template.split(token).join(value);
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return template
    .replace(new RegExp(`${escaped}[\\s_\\-]`, 'g'), '')
    .replace(new RegExp(`[\\s_\\-]${escaped}`, 'g'), '')
    .split(token)
    .join('');
}

/** 按模板渲染文件名（只做变量替换，不做清洗） */
export function renderTemplate(
  template: string,
  vars: { author?: string; title?: string; index?: number; ext?: string },
): string {
  const { author = '', title = '', index = 0, ext = '' } = vars;
  return fillToken(
    fillToken(fillToken(fillToken(template, '{author}', author), '{title}', title), '{index}', String(index)),
    '{ext}',
    ext,
  );
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i += 1;
  }
  return `${value >= 100 ? value.toFixed(0) : value.toFixed(1)} ${units[i]}`;
}

export function formatSpeed(bytesPerSecond: number): string {
  if (!Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) return '';
  return `${formatBytes(bytesPerSecond)}/s`;
}

export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '';
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return m > 0 ? `${m}:${String(s).padStart(2, '0')}` : `${s}s`;
}

/**
 * 小红书图片 CDN 的 URL 形如
 *   http://sns-webpic-qc.xhscdn.com/xxx/yyy.jpg!nd_dft_wgth_webp_3
 * 末尾的 `!xxx` 是处理指令，去掉即可拿到原图。
 */
export function normalizeImageUrl(raw: string): string {
  if (!raw) return '';
  let url = raw.split('!')[0] ?? '';
  if (url.startsWith('http://')) url = `https://${url.slice('http://'.length)}`;
  return url;
}

/** 视频直链可能是 m3u8，需要特殊处理 */
export function normalizeVideoUrl(raw: string): string {
  if (!raw) return '';
  let url = raw.trim();
  if (url.startsWith('http://')) url = `https://${url.slice('http://'.length)}`;
  return url;
}

export function isM3u8(url: string): boolean {
  return /\.m3u8(\?|$)/i.test(url);
}

/** 从 URL 里猜扩展名 */
export function guessExtension(url: string, fallback = 'jpg'): string {
  try {
    const path = new URL(url).pathname;
    const m = path.match(/\.([a-z0-9]{2,5})$/i);
    if (m?.[1]) {
      const ext = m[1].toLowerCase();
      if (['jpg', 'jpeg', 'png', 'webp', 'gif', 'avif', 'bmp', 'mp4', 'm4v', 'mov'].includes(ext)) {
        return ext === 'jpeg' ? 'jpg' : ext;
      }
    }
  } catch {
    /* ignore */
  }
  return fallback;
}

/** 简单节流 */
export function throttle<T extends (...args: never[]) => void>(fn: T, ms: number): T {
  let last = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  return ((...args: never[]) => {
    const now = Date.now();
    const remaining = ms - (now - last);
    if (remaining <= 0) {
      last = now;
      fn(...args);
    } else if (!timer) {
      timer = setTimeout(() => {
        timer = null;
        last = Date.now();
        fn(...args);
      }, remaining);
    }
  }) as T;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 生成短 id */
export function shortId(prefix = ''): string {
  return `${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}
