/**
 * MAIN world 下的原始数据提取。
 *
 * 小红书 Web 端把笔记的完整数据放在 `window.__INITIAL_STATE__` 里（注意：部分字段是 Vue ref，需要 unref）：
 *   note.noteDetailMap[noteId].note  → { title, imageList[], video.media.stream.EF4/EF5[], user, ... }
 *   user.notes[]                     → 主页笔记列表（卡片信息，不含媒体直链）
 *
 * 本文件的规则均经过线上实测验证（2026-10）：
 *   - 图片原图 = https://sns-img-qc.xhscdn.com/{fileId}   （去掉签名 hash 段；保留 32 位 hex 之前的目录段则 404）
 *   - 图片直接剥 `!suffix` 会 403（签名与后缀绑定）
 *   - 视频流分桶是 EF4 / EF5 / EF6 / EF7（不是 h264/h265），全部是 progressive mp4
 *   - backupUrls[0] 无需签名即可下载，masterUrl 带 sign/t 会过期
 */

export interface RawImage {
  /** 原图直链 */
  url: string;
  /** 页面里用的缩略图（webp，小图） */
  previewUrl: string;
  width?: number;
  height?: number;
  fileId?: string;
  live?: boolean;
}

export interface RawVideo {
  url: string;
  backupUrls: string[];
  duration?: number;
  width?: number;
  height?: number;
  size?: number;
  quality?: string;
  format?: string;
}

export interface RawNote {
  noteId: string;
  type: 'normal' | 'video';
  title: string;
  desc: string;
  author: string;
  authorId?: string;
  avatar?: string;
  likedCount?: number;
  publishTime?: string;
  cover?: string;
  images: RawImage[];
  videos: RawVideo[];
}

/** 主页列表里的一条笔记（只有卡片信息） */
export interface RawNoteRef {
  noteId: string;
  xsecToken?: string;
  title?: string;
  type: 'normal' | 'video';
  cover?: string;
  likedCount?: number;
  index?: number;
}

type AnyObj = Record<string, any>;

export function isObj(v: unknown): v is AnyObj {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Vue 的 ref 需要解包 */
export function unref<T = any>(v: T): T {
  if (v && typeof v === 'object' && '__v_isRef' in (v as any)) {
    return (v as any)._value;
  }
  return v;
}

/** 取字符串，顺手处理小红书序列化时把 undefined 写成字符串 "undefined" 的坑 */
export function str(v: unknown): string {
  if (typeof v === 'string') return v === 'undefined' ? '' : v;
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return '';
}

export function num(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const cleaned = v === 'undefined' ? '' : v;
    if (!cleaned) return undefined;
    const n = Number(cleaned);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

/** 安全地沿路径取值 */
export function pick(root: unknown, ...path: string[]): any {
  let cur: any = root;
  for (const key of path) {
    if (!isObj(cur) && !Array.isArray(cur)) return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

/** 数组化（小红书某些字段会是单对象或数组） */
export function asArray(v: unknown): any[] {
  const u = unref(v);
  if (Array.isArray(u)) return u;
  if (u === undefined || u === null) return [];
  if (isObj(u)) return [u];
  return [];
}

/* ------------------------------------------------------------------ */
/* 图片                                                                */
/* ------------------------------------------------------------------ */

const SIGNED_HASH = /^[0-9a-f]{32}$/;

/**
 * 由 CDN URL 推出原图直链。
 * 实测：
 *   .../202610241211/{32位hash}/{fileId}!suffix  →  https://sns-img-qc.xhscdn.com/{fileId}
 *   .../{32位hash}/{dir}/{fileId}!suffix          →  https://sns-img-qc.xhscdn.com/{dir}/{fileId}
 */
export function originalImageUrl(raw: string): string {
  if (!raw) return '';
  let url = raw.trim().replace(/^http:\/\//, 'https://');
  // 已经是原图直链，别再改写（否则会拼出双斜杠）
  if (url.startsWith('https://sns-img-qc.xhscdn.com/')) {
    return url.split('?')[0] ?? url;
  }
  let pathname: string;
  try {
    pathname = new URL(url).pathname;
  } catch {
    return url;
  }
  const segments = pathname.split('/').filter(Boolean);
  if (segments.length === 0) return url;

  const last = segments[segments.length - 1] ?? '';
  const fileId = last.split('!')[0] ?? '';
  if (!fileId) return url;

  const prev = segments[segments.length - 2] ?? '';
  // 上一段是 32 位 hex 签名目录 → 只保留 fileId；否则上一段是业务目录（notes_pre_post 等），要一起保留
  const keep = SIGNED_HASH.test(prev) ? [fileId] : [prev, fileId];
  return `https://sns-img-qc.xhscdn.com/${keep.join('/')}`;
}

/** 统一转成 JPEG 的原图直链（兼容性最好，扩展名稳定为 .jpg） */
export function jpegImageUrl(raw: string): string {
  const base = originalImageUrl(raw).split('?')[0] ?? '';
  if (!base.startsWith('https://sns-img-qc.xhscdn.com/')) return originalImageUrl(raw);
  return `${base}?imageView2/format/jpeg`;
}

function extractImages(raw: any): RawImage[] {
  const list = asArray(raw?.imageList ?? raw?.images ?? raw?.image_list);
  const out: RawImage[] = [];
  for (const item of list) {
    if (!isObj(item)) continue;

    let preview = str(item.urlDefault) || str(item.url_default) || str(item.urlPre) || str(item.url_pre);
    if (!preview) {
      const infoList = asArray(item.infoList ?? item.info_list);
      const dft = infoList.find(
        (i) => isObj(i) && (str(i.imageScene) === 'WB_DFT' || str(i.image_scene) === 'WB_DFT'),
      );
      preview = isObj(dft) ? str(dft.url) : '';
    }
    if (!preview) continue;

    out.push({
      url: originalImageUrl(preview),
      previewUrl: preview.replace(/^http:\/\//, 'https://'),
      width: num(item.width),
      height: num(item.height),
      fileId: str(item.fileId) || str(item.file_id) || undefined,
      live: Boolean(item.livePhoto ?? item.live_photo ?? false),
    });
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* 视频                                                                */
/* ------------------------------------------------------------------ */

interface StreamEntry {
  masterUrl: string;
  backupUrls: string[];
  duration?: number;
  width?: number;
  height?: number;
  size?: number;
  format?: string;
  quality?: string;
}

function readStreamEntry(entry: any): StreamEntry | null {
  if (!isObj(entry)) return null;
  const masterUrl = str(entry.masterUrl) || str(entry.master_url) || str(entry.url);
  if (!masterUrl) return null;

  const backupUrls = asArray(entry.backupUrls ?? entry.backup_urls)
    .map((u) => str(u).replace(/^http:\/\//, 'https://'))
    .filter(Boolean);

  let duration = num(entry.duration ?? entry.videoDuration ?? entry.video_duration);
  // duration 字段是毫秒；videoDuration 也是毫秒
  if (duration !== undefined && duration > 1000) duration = duration / 1000;

  return {
    masterUrl: masterUrl.replace(/^http:\/\//, 'https://'),
    backupUrls,
    duration,
    width: num(entry.width),
    height: num(entry.height),
    size: num(entry.size),
    format: str(entry.format) || undefined,
    quality: str(entry.qualityType) || undefined,
  };
}

function collectStreamEntries(stream: any): StreamEntry[] {
  const out: StreamEntry[] = [];
  const source = unref(stream);
  if (!isObj(source)) return out;
  for (const bucket of Object.values(source)) {
    for (const entry of asArray(bucket)) {
      const parsed = readStreamEntry(entry);
      if (parsed) out.push(parsed);
    }
  }
  return out;
}

function extractVideos(raw: any): RawVideo[] {
  // 视频信息正常挂在 raw.video 下；但站点改版时也见过直接挂在 raw.media 上的，
  // 两个都试一遍 —— 少一条路就意味着「视频一条都解析不出来」。
  const video = isObj(raw?.video) ? raw.video : isObj(raw?.media) ? raw.media : undefined;
  if (!video) return [];

  const media = isObj(video.media) ? video.media : {};
  let entries = collectStreamEntries(media.stream);
  if (entries.length === 0) entries = collectStreamEntries(video.stream);

  // mediaV2 是一段 JSON 字符串，结构类似，作为兜底
  if (entries.length === 0) {
    const mediaV2 = str(video.mediaV2) || str(raw?.mediaV2);
    if (mediaV2) {
      try {
        const parsed = JSON.parse(mediaV2);
        entries = collectStreamEntries(parsed?.stream);
      } catch {
        /* ignore */
      }
    }
  }

  if (entries.length === 0) return [];

  // 只要 mp4（小红书 Web 端实测全部是 progressive mp4，没有 m3u8）
  const mp4s = entries.filter((e) => !e.format || e.format === 'mp4');
  const pool = mp4s.length > 0 ? mp4s : entries;

  // 优先分辨率最高的那一路
  pool.sort((a, b) => (b.width ?? 0) * (b.height ?? 0) - (a.width ?? 0) * (a.height ?? 0));

  return pool.map<RawVideo>((e) => ({
    // backupUrls[0] 不带签名、更稳定，masterUrl 作为兜底
    url: e.backupUrls[0] ?? e.masterUrl,
    backupUrls: e.backupUrls.length > 0 ? e.backupUrls : [e.masterUrl],
    duration: e.duration,
    width: e.width,
    height: e.height,
    size: e.size,
    quality: e.quality,
    format: e.format,
  }));
}

/* ------------------------------------------------------------------ */
/* 笔记详情                                                            */
/* ------------------------------------------------------------------ */

export function extractNote(raw: any): RawNote | null {
  if (!isObj(raw)) return null;
  const noteId = str(raw.noteId) || str(raw.note_id) || str(raw.id);
  if (!noteId) return null;

  const user = isObj(raw.user) ? raw.user : isObj(raw.userInfo) ? raw.userInfo : {};
  const interact = isObj(raw.interactInfo)
    ? raw.interactInfo
    : isObj(raw.interact_info)
      ? raw.interact_info
      : {};

  const images = extractImages(raw);
  const videos = extractVideos(raw);
  const coverRaw =
    str(raw.cover?.urlDefault) ||
    str(raw.cover?.url_default) ||
    str(raw.cover) ||
    images[0]?.previewUrl ||
    '';

  return {
    noteId,
    type: str(raw.type) === 'video' ? 'video' : 'normal',
    // 标题取值链：title → displayTitle → 正文首行
    // （小红书有一部分笔记的 title 是空串，真正的标题在 desc 里）
    title: str(raw.title) || str(raw.displayTitle) || titleFromDesc(raw.desc) || '',
    desc: str(raw.desc) || '',
    author: str(user.nickname) || str(user.nickName) || str(user.name) || '',
    authorId: str(user.userId) || str(user.user_id) || undefined,
    avatar: str(user.avatar) || undefined,
    likedCount: num(interact.likedCount ?? interact.liked_count),
    publishTime: str(raw.time ?? raw.lastUpdateTime) || undefined,
    cover: coverRaw ? coverRaw.replace(/^http:\/\//, 'https://') : undefined,
    images,
    videos,
  };
}

/**
 * 从正文（desc）里推导标题。
 *
 * 为什么要这一步：**小红书有一部分笔记的 `title` 字段是空字符串**，
 * 真正的标题被放进了 `desc`（实测 2026-10：这类笔记在推荐流里不少）。
 * 不做这一步，这些笔记的文件名就会退化成笔记编号 —— 一串数字，
 * 用户完全看不出下的是哪条内容。
 *
 * 规则：
 *   - 只看第一行（正文通常第一行是标题，后面是长文）
 *   - 去掉 `#话题` 与 `[表情]` 这类后缀
 *   - 以 `#` 开头说明整段都是话题标签，不算标题
 *   - 太长的不像标题（正文首行），宁可不要
 */
export function titleFromDesc(desc: unknown): string {
  const text = str(desc);
  if (!text) return '';
  const firstLine = (text.split('\n')[0] ?? '').trim();
  if (!firstLine || firstLine.startsWith('#')) return '';
  const cleaned = firstLine
    .split('#')[0]!
    .replace(/\[[^\]]{1,20}\]/g, '')
    .trim();
  if (!cleaned) return '';
  // 正文首行往往很长，超过这个长度就不当作标题了
  if (Array.from(cleaned).length > 60) return '';
  return cleaned;
}

/**
 * 一条笔记有没有可下载的媒体（视频或图片）。
 *
 * **空壳笔记不算。**
 * 页面的状态是先有 id、标题，媒体（视频直链 / 图片列表）是后补的 ——
 * 早一步读到的就是「有 id 没视频」的空壳。
 * 把它当成解析成功，界面上就是「解析成功但一个视频都没有」：
 * 既不报错也不重试，用户只能看着干着急。
 */
export function hasMedia(note: RawNote): boolean {
  return note.videos.length > 0 || note.images.length > 0;
}

/* ------------------------------------------------------------------ */
/* 在任意数据里找一条笔记                                              */
/* ------------------------------------------------------------------ */

/** 深搜时最多看多少个节点（小红书的状态很大，无上限会把主线程占住） */
const DEEP_SEARCH_BUDGET = 12000;
/** 深搜的最大深度 */
const DEEP_SEARCH_DEPTH = 12;

/**
 * 在任意一份数据里找出「某条笔记」，找不到返回 null。
 *
 * **为什么要深搜**：
 * 小红书把笔记详情放在数据的哪个位置，隔一阵就会变
 * （实测见过 `note.noteDetailMap[id].note`、`note.noteList`…）。
 * 已知路径一旦失手，结果就是「整条笔记解析不出来」——
 * 页面上视频明明在，扩展却一条都拿不到（用户看到的就是「彻底解析不了」）。
 *
 * 所以已知路径取不到时，把整份数据翻一遍：
 * 找到「id 对得上、并且带媒体」的那个对象，就用它。
 *
 * **只认 id 对得上的**：拿错笔记 = 下错内容，比失败糟糕得多。
 *
 * @param payload 任意数据（页面状态、接口响应……）
 * @param noteId  要找的笔记 id；不给就是「哪条都行」（有媒体的那条）
 */
export function findNoteInPayload(payload: unknown, noteId?: string): RawNote | null {
  if (!isObj(payload)) return null;

  // 已知路径先试（快，而且能保证拿到的是「这一条」）
  const known = extractNoteFromState(payload, noteId);
  if (known && hasMedia(known)) return known;

  // 深搜兜底
  let budget = DEEP_SEARCH_BUDGET;
  const seen = new WeakSet<object>();

  const visit = (
    node: unknown,
    depth: number,
    key: string,
    parentId: string,
  ): RawNote | null => {
    if (budget <= 0) return null;
    if (node === null || typeof node !== 'object') return null;
    if (depth > DEEP_SEARCH_DEPTH) return null;
    if (seen.has(node)) return null;
    seen.add(node);
    budget -= 1;

    if (Array.isArray(node)) {
      for (const child of node) {
        const hit = visit(child, depth + 1, key, parentId);
        if (hit) return hit;
      }
      return null;
    }

    if (!isObj(node)) return null;

    const hit = matchNote(node, noteId, key, parentId);
    if (hit) return hit;

    // 自己身上没有 id 的话，把外层的 id 传下去 ——
    // 接口响应里常见的形状是 `{id, note_card: {...}}`，
    // 媒体在 note_card 里、id 在外层。
    const myId = str(node.noteId) || str(node.note_id) || str(node.id) || parentId;
    for (const childKey of Object.keys(node)) {
      const hit2 = visit(node[childKey], depth + 1, childKey, myId);
      if (hit2) return hit2;
    }
    return null;
  };

  return visit(payload, 0, '', '');
}

/**
 * 一个对象能不能当成「我们那条笔记」。
 *
 * 站点把笔记包在各种壳里（`{note: {...}}`、`{note_card: {...}}`…），
 * 壳里没写 id 的时候用外层的 id 补上 —— 外层那个就是笔记 id
 * （`noteDetailMap[id].note`、接口响应的 `{id, note_card}` 都是这个形状）。
 */
function matchNote(node: any, noteId: string | undefined, key: string, parentId: string): RawNote | null {
  const candidates: any[] = [node];
  for (const childKey of ['note', 'noteCard', 'note_card', 'noteInfo', 'detail']) {
    const child = node[childKey];
    if (isObj(child)) candidates.push(child);
  }

  for (const candidate of candidates) {
    const ownId = str(candidate.noteId) || str(candidate.note_id) || str(candidate.id);
    const idFallback = ownId || parentId || key;
    let note = extractNote(candidate);
    // 壳里没写 id，但外层有 —— 补上再试一次
    if (!note && idFallback) note = extractNote({ ...candidate, noteId: idFallback });
    if (!note) continue;
    if (noteId && note.noteId !== noteId) continue;
    if (!hasMedia(note)) continue;
    return note;
  }
  return null;
}

/**
 * 从 __INITIAL_STATE__ 里取出笔记详情。
 *
 * 传了 noteId 就必须精确命中：拿不到就返回 null。
 * 早期版本这里会「命中不了就退回状态里的任意一条」，
 * 结果是批量下载时把别的笔记当成了用户勾选的那条 —— 静默下错内容，
 * 比直接失败糟糕得多。
 *
 * 不传 noteId 时才回退到「页面当前这条」。
 */
export function extractNoteFromState(state: any, noteId?: string): RawNote | null {
  if (!isObj(state)) return null;

  const detailMap = pick(state, 'note', 'noteDetailMap');
  if (isObj(detailMap)) {
    const targetId = str(unref(pick(state, 'note', 'firstNoteId')));
    const candidates = noteId
      ? [noteId]
      : [...(targetId ? [targetId] : []), ...Object.keys(detailMap)];
    for (const id of candidates) {
      if (!id || id === 'undefined') continue;
      const entry = detailMap[id];
      if (!isObj(entry)) continue;
      const raw = isObj(entry.note) ? entry.note : entry;
      const note = extractNote(raw);
      if (note) {
        // 状态里的 key 和笔记自己的 id 可能不一致，以笔记自己的为准
        if (noteId && note.noteId && note.noteId !== noteId) continue;
        return note;
      }
    }
  }

  const noteList = pick(state, 'note', 'noteList') ?? pick(state, 'feed', 'noteList');
  for (const entry of asArray(noteList)) {
    const note = extractNote(entry);
    if (note && (!noteId || note.noteId === noteId)) return note;
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* 主页笔记列表                                                        */
/* ------------------------------------------------------------------ */

function extractNoteRef(raw: any): RawNoteRef | null {
  if (!isObj(raw)) return null;
  const card = isObj(raw.noteCard) ? raw.noteCard : isObj(raw.note_card) ? raw.note_card : raw;
  const noteId = str(raw.id) || str(raw.noteId) || str(card.noteId) || str(card.id) || str(card.note_id);
  if (!noteId) return null;

  const coverUrl =
    str(card.cover?.urlDefault) ||
    str(card.cover?.url_default) ||
    str(card.cover?.url) ||
    str(card.cover) ||
    '';
  const type = str(card.type) === 'video' ? 'video' : 'normal';
  const liked = num(card.interactInfo?.likedCount ?? card.interact_info?.liked_count);
  const title = str(card.displayTitle) || str(card.display_title) || str(card.title) || '';

  return {
    noteId,
    xsecToken: str(raw.xsecToken) || str(raw.xsec_token) || str(card.xsecToken) || undefined,
    title: title || undefined,
    type,
    cover: coverUrl ? coverUrl.replace(/^http:\/\//, 'https://') : undefined,
    likedCount: liked,
  };
}

/**
 * 收集主页里的全部笔记引用。
 * 先走已知路径，再用深搜兜底（小红书字段结构随版本变动较频繁）。
 */
export function collectNoteRefs(state: any): RawNoteRef[] {
  const found = new Map<string, RawNoteRef>();

  const push = (raw: any) => {
    const ref = extractNoteRef(raw);
    if (ref && !found.has(ref.noteId)) found.set(ref.noteId, ref);
  };

  const knownPaths: unknown[] = [
    pick(state, 'user', 'notes'),
    pick(state, 'user', 'noteQueries'),
    pick(state, 'user', 'postedNotes'),
    pick(state, 'note', 'noteList'),
  ];

  for (const p of knownPaths) {
    for (const entry of asArray(p)) {
      if (isObj(entry) && Array.isArray(unref(entry.noteList))) {
        for (const sub of asArray(entry.noteList)) push(sub);
      } else {
        push(entry);
      }
    }
  }

  if (found.size === 0) {
    deepCollectNotes(state, push, new WeakSet(), 0);
  }

  return Array.from(found.values());
}

/** 深搜：找出所有「像笔记」的节点 */
function deepCollectNotes(
  node: any,
  push: (raw: any) => void,
  seen: WeakSet<object>,
  depth: number,
): void {
  if (depth > 10 || node === null || typeof node !== 'object') return;
  if (seen.has(node)) return;
  seen.add(node);

  if (Array.isArray(node)) {
    for (const child of node) deepCollectNotes(child, push, seen, depth + 1);
    return;
  }

  if (isObj(node)) {
    const hasNoteId = typeof node.noteId === 'string' && node.noteId.length > 4;
    const hasCard = isObj(node.noteCard) || isObj(node.note_card);
    const hasId = typeof node.id === 'string' && node.id.length > 4;
    if (
      (hasNoteId || hasCard || (hasId && (node.type === 'video' || node.type === 'normal'))) &&
      (node.imageList || node.cover || node.noteCard || node.note_card || node.displayTitle || node.display_title)
    ) {
      push(node);
    }
    for (const key of Object.keys(node)) {
      if (key === 'noteCard' || key === 'note_card') continue;
      deepCollectNotes(node[key], push, seen, depth + 1);
    }
  }
}

/* ------------------------------------------------------------------ */
/* 用户信息                                                            */
/* ------------------------------------------------------------------ */

export function extractUser(state: any): { userId?: string; nickname?: string; avatar?: string } {
  const user = pick(state, 'user');
  const basic = isObj(user) ? user : {};
  const basicInfo = isObj(basic.basicInfo) ? basic.basicInfo : {};
  return {
    userId: str(basic.userId) || str(basicInfo.redId) || undefined,
    nickname: str(basic.nickname) || str(basicInfo.nickname) || undefined,
    avatar: str(basic.avatar) || str(basicInfo.imageb) || undefined,
  };
}

/* ------------------------------------------------------------------ */
/* 页面状态里内联的 __INITIAL_STATE__                                  */
/* ------------------------------------------------------------------ */

/**
 * 从 HTML 里抠出 __INITIAL_STATE__。
 *
 * 站点把它内联在 <script> 里，形如 `window.__INITIAL_STATE__={...}`。
 * 不能用正则去匹配对象（里面的字符串里可能有花括号），
 * 所以按括号配平扫描，跳过字符串字面量。
 *
 * **注意：它不是 JSON，是 JavaScript 对象字面量。**
 * 实测（2026-10-24 真实站点）：状态里有 20~30 处 `undefined`，
 * 直接 `JSON.parse` 一定抛错。所以解析失败时要再试一次 ——
 * 把字符串外面的 `undefined` 换成 `null` 再解。
 */
export function parseInitialState(html: string): any | null {
  const marker = 'window.__INITIAL_STATE__';
  const at = html.indexOf(marker);
  if (at < 0) return null;
  const eq = html.indexOf('=', at + marker.length);
  if (eq < 0) return null;
  const start = html.indexOf('{', eq);
  if (start < 0) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < html.length; i += 1) {
    const ch = html.charAt(i);
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '{') {
      depth += 1;
    } else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        const text = html.slice(start, i + 1);
        try {
          return JSON.parse(text);
        } catch {
          return parseJsLiteral(text);
        }
      }
    }
  }
  return null;
}

/**
 * 解析 JavaScript 对象字面量（不是 JSON）。
 *
 * 只做一件事：把字符串外面的 `undefined` / `NaN` / `Infinity` 换成 `null`，
 * 让剩下的文本变成合法 JSON。
 *
 * 为什么不直接 `new Function('return (' + text + ')')()`：
 * 那等于执行站点给的代码。没必要 —— 实测站点状态里只有 `undefined`
 * 这一个非 JSON 字面量（2026-10-24 真实站点，29 处），
 * 替换掉就够了，而且不执行任何外来代码。
 */
function parseJsLiteral(text: string): any | null {
  let out = '';
  let inString = false;
  let escaped = false;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text.charAt(i) as string;
    if (inString) {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    // 只有独立成词的 undefined 才换 —— "undefined" 这种字符串不动
    if (isWordAt(text, i, 'undefined')) {
      out += 'null';
      i += 'undefined'.length - 1;
      continue;
    }
    if (isWordAt(text, i, 'NaN') || isWordAt(text, i, 'Infinity')) {
      // -Infinity 要连着前面的负号一起换掉，不然会留下一个非法的 "-null"
      if (out.endsWith('-')) out = out.slice(0, -1);
      out += 'null';
      i += text.startsWith('Infinity', i) ? 'Infinity'.length - 1 : 'NaN'.length - 1;
      continue;
    }
    out += ch;
  }

  try {
    return JSON.parse(out);
  } catch {
    return null;
  }
}

/** text[i] 处是不是一个独立的单词（前后不是标识符字符） */
function isWordAt(text: string, i: number, word: string): boolean {
  if (!text.startsWith(word, i)) return false;
  const before = text.charAt(i - 1);
  const after = text.charAt(i + word.length);
  return !/[\w$]/.test(before) && !/[\w$]/.test(after);
}
