import type { MediaItem, NoteInfo, Settings } from '../../shared/types';
import {
  effectiveTemplate,
  guessExtension,
  renderTemplate,
  sanitizeSegment,
  sanitizeStem,
  buildSafeFileName,
  finalizeFileName,
  isM3u8,
} from '../../shared/utils';
import type { RawNote } from './raw';
import { jpegImageUrl, originalImageUrl } from './raw';

export interface BuildContext {
  settings: Settings;
  /** 相对浏览器下载目录的根目录 */
  rootFolder: string;
}

/**
 * 计算落盘的相对路径
 *
 * 三种保存结构（其实只是目录有几层）：
 *   - perNote（独立文件夹）：`根目录/作者/标题/1.mp4` —— 目录承担身份
 *   - perAuthor（按作者分文件夹）：`根目录/作者/标题_1.mp4` —— 目录分作者，文件名分笔记
 *   - flat（全部放一起）：`根目录/作者_标题_1.mp4` —— 文件名承担身份
 */
export function buildRelativePath(
  ctx: BuildContext,
  opts: { author?: string; title?: string; filename: string },
): string {
  const segments: string[] = [];
  if (ctx.rootFolder) segments.push(sanitizeSegment(ctx.rootFolder, 40));
  if (ctx.settings.saveStructure === 'perNote') {
    if (opts.author) segments.push(sanitizeSegment(opts.author, 40));
    if (opts.title) segments.push(sanitizeSegment(opts.title, 60));
  } else if (ctx.settings.saveStructure === 'perAuthor') {
    // 作者这一层保留：把不同作者的内容直接倒进同一个主文件夹确实不好认
    if (opts.author) segments.push(sanitizeSegment(opts.author, 40));
  }
  // 文件名在 buildFileName 里已经保证合法（词干 + 扩展名分别过规则），
  // 这里只做兜底清洗，且不截断 —— 截断会把扩展名砍掉。
  segments.push(sanitizeSegment(opts.filename, 200));
  return segments.join('/');
}

/**
 * 渲染一个媒体项的文件名（不含目录）
 *
 * 拆成「词干 + 扩展名」两步：Chromium 对扩展名和词干是两套规则
 * （"foo.url" 整个被拒，"foo.url.jpg" 却能用），而且截断必须只切词干 ——
 * 直接截断整串会把 ".jpg" 砍成 ".jp"，用户拿到的文件根本打不开。
 */
export function buildFileName(
  settings: Settings,
  opts: { author?: string; title?: string; index: number; ext: string },
): string {
  const template = effectiveTemplate(settings);
  const vars = { author: opts.author ?? '', title: opts.title ?? '', index: opts.index };

  // 模板里没写 {ext}：补在末尾（没扩展名的文件打不开）
  if (!template.includes('{ext}')) {
    return buildSafeFileName(renderTemplate(template, vars), opts.ext, 80);
  }

  // 写了 {ext}：按模板给的位置放。
  // 拆的是模板而不是渲染结果 —— 渲染结果里分不清「模板的点」和「标题里的点」。
  const [headTpl = '', tailTpl = ''] = template.split('{ext}');
  const head = renderTemplate(headTpl, vars);
  const tail = renderTemplate(tailTpl, vars);

  if (!tail) {
    // {ext} 在末尾 —— 最常见的情况（"{title}.{ext}"）
    return buildSafeFileName(head, opts.ext, 80);
  }

  // {ext} 在中间（"{ext}_副本" 这种）：前后都是词干
  const extPart = sanitizeSegment((opts.ext ?? '').replace(/^\.+/, ''), 10);
  if (!extPart) return buildSafeFileName(head + tail, 'jpg', 80);
  const headPart = head ? sanitizeStem(head, 40) : '';
  const tailPart = sanitizeStem(tail, 20);
  return finalizeFileName(`${headPart}${headPart ? '.' : ''}${extPart}${tailPart}`);
}

/** 视频：优先用不带签名的 backup 地址，master 作为兜底 */
function pickVideoUrl(candidate: { url: string; backupUrls: string[] }): string {
  return candidate.backupUrls[0] ?? candidate.url;
}

/**
 * 按当前设置算出一个媒体项的文件名。
 *
 * 文件名依赖设置（命名模板、保存结构），所以不能在识别的时候就定死 ——
 * 用户随时可能在面板里改模板或切换保存结构，定死的话面板显示的还是旧名字，
 * 落盘的文件名却变了，两边对不上。
 */
export function fileNameForItem(settings: Settings, item: MediaItem): string {
  const ext = guessExtension(item.url, item.kind === 'video' ? 'mp4' : 'jpg');
  return buildFileName(settings, {
    author: item.author,
    title: item.noteTitle,
    index: item.index,
    ext,
  });
}

/**
 * RawNote → MediaItem[]
 *
 * `titleOverride` 是给「标题缺失」准备的兜底：主页批量下载时，
 * 列表卡片上的标题（来自推荐流的 displayTitle）比笔记详情里的更可靠，
 * 传进来可以保证「面板显示什么，文件名就是什么」。
 */
export function noteToMediaItems(
  note: RawNote,
  settings: Settings,
  titleOverride?: string,
): MediaItem[] {
  const items: MediaItem[] = [];
  const author = note.author || '';
  // 标题为空时不再拿笔记编号顶替 —— 那会让文件名变成一串数字，
  // 用户完全认不出下的是哪条内容。
  const title = (titleOverride || note.title || '').trim();
  const noteUrl = `https://www.xiaohongshu.com/explore/${note.noteId}`;

  // 视频和图片连续编号（1 起），这样「作者/标题/1.mp4、2.jpg」这样的目录很整齐
  let seq = 0;

  // 视频
  if (note.videos.length > 0) {
    const video = note.videos[0]!;
    const url = pickVideoUrl(video);
    const ext = guessExtension(url, 'mp4');
    seq += 1;
    items.push({
      id: `${note.noteId}-v`,
      kind: 'video',
      url,
      thumbUrl: note.cover,
      filename: buildFileName(settings, { author, title, index: seq, ext }),
      size: video.size,
      width: video.width,
      height: video.height,
      index: seq,
      noteId: note.noteId,
      noteTitle: title || undefined,
      noteUrl,
      author,
      isStream: isM3u8(url),
      duration: video.duration,
    });
  }

  // 图片
  note.images.forEach((image) => {
    const useOriginal = settings.imageFormat === 'original';
    const url = useOriginal ? originalImageUrl(image.url) : jpegImageUrl(image.url);
    if (!url) return;
    const ext = useOriginal ? guessExtension(url, 'jpg') : 'jpg';
    seq += 1;
    items.push({
      id: `${note.noteId}-i${seq}`,
      kind: 'image',
      url,
      thumbUrl: image.previewUrl,
      filename: buildFileName(settings, { author, title, index: seq, ext }),
      width: image.width,
      height: image.height,
      index: seq,
      noteId: note.noteId,
      noteTitle: title || undefined,
      noteUrl,
      author,
    });
  });

  return items;
}

/** RawNote → NoteInfo */
export function noteToInfo(
  note: RawNote,
  settings: Settings,
  url: string,
  titleOverride?: string,
): NoteInfo {
  const title = (titleOverride || note.title || '').trim();
  return {
    noteId: note.noteId,
    title,
    desc: note.desc,
    author: note.author,
    authorId: note.authorId,
    avatar: note.avatar,
    type: note.type,
    url,
    items: noteToMediaItems(note, settings, title),
    cover: note.cover,
    likedCount: note.likedCount,
    publishTime: note.publishTime,
    source: 'initial-state',
  };
}
