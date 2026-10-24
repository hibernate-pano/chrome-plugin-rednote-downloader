import type { PageBridge } from '../bridge';
import type { MediaItem, NoteInfo, Settings } from '../../shared/types';
import { shortId, sleep } from '../../shared/utils';
import { noteToInfo, noteToMediaItems } from './media';
import type { RawNote, RawNoteRef } from './raw';
import { isObj, num, str, unref } from './raw';

export type PageKind = 'note' | 'profile' | 'unknown';

export function classifyPage(path: string): PageKind {
  if (/\/explore\/[A-Za-z0-9_-]+/i.test(path)) return 'note';
  if (/\/discovery\/item\/[A-Za-z0-9_-]+/i.test(path)) return 'note';
  if (/\/user\/profile\/[A-Za-z0-9_-]+/i.test(path)) return 'profile';
  return 'unknown';
}

/** 主页扫描结果 */
export interface ProfileScan {
  refs: RawNoteRef[];
  /** 扫描过程中的提示，用于 UI 展示 */
  rounds: number;
  /** 站点没有返回笔记 id —— 通常意味着需要登录 */
  blocked?: boolean;
  blockedReason?: string;
}

export interface DetectDeps {
  bridge: PageBridge;
  getSettings: () => Settings;
}

export class Detector {
  constructor(private deps: DetectDeps) {}

  /* ---------------------------------------------------------------- */
  /* 笔记详情页                                                        */
  /* ---------------------------------------------------------------- */

  /**
   * 只走页面数据（__INITIAL_STATE__）—— 这是最可靠的来源，
   * 拿到的直链不带临时签名失效问题。
   */
  async detectNoteFromState(path: string): Promise<NoteInfo | null> {
    const { bridge, getSettings } = this.deps;
    const settings = getSettings();

    const noteId = path.match(/\/(?:explore|discovery\/item)\/([A-Za-z0-9_-]+)/i)?.[1];

    try {
      const res = await bridge.call<{ note: RawNote | null }>('state.note', { noteId, loose: true });
      if (res?.note) {
        const info = noteToInfo(res.note, settings, location.href);
        info.source = 'initial-state';
        return info;
      }
    } catch {
      /* fallthrough */
    }
    return null;
  }

  /**
   * DOM 兜底：页面数据拿不到时，从渲染出来的 <img> / <video> 里扒直链。
   * 注意这是最后手段 —— DOM 里的视频地址常常是 blob: 或带会过期的签名。
   */
  detectNoteFromDom(path: string): NoteInfo | null {
    const { getSettings } = this.deps;
    const settings = getSettings();
    const noteId = path.match(/\/(?:explore|discovery\/item)\/([A-Za-z0-9_-]+)/i)?.[1] ?? '';
    if (!noteId) return null;

    const title =
      str(document.querySelector('#detail-title, .note-content .title, h1.title')?.textContent) ?? '';
    const authorEl = document.querySelector(
      '.author-container .username, .author-wrapper .username, a.author',
    );
    const author = authorEl?.textContent?.trim() ?? '';

    // 视频：blob: 是 MSE 流，下载不了，直接排除
    const videoCandidates: string[] = [];
    document.querySelectorAll('video').forEach((v) => {
      if (v.currentSrc) videoCandidates.push(v.currentSrc);
      if (v.getAttribute('src')) videoCandidates.push(v.getAttribute('src')!);
      v.querySelectorAll('source').forEach((s) => {
        if (s.getAttribute('src')) videoCandidates.push(s.getAttribute('src')!);
      });
    });
    const videoSrc =
      videoCandidates.find((u) => /^https?:\/\//.test(u) && !/^https?:\/\/[^/]*xhscdn/.test(u)) ??
      videoCandidates.find((u) => /^https?:\/\//.test(u)) ??
      '';

    const imageEls = Array.from(
      document.querySelectorAll(
        '.note-slider-img img, .swiper-slide img, .media-container img, .note-content img, img.note-content-img',
      ),
    ) as HTMLImageElement[];
    const images = imageEls
      .map((img) => ({
        url: img.getAttribute('src') ?? '',
        previewUrl: img.getAttribute('src') ?? '',
        width: num(img.naturalWidth),
        height: num(img.naturalHeight),
      }))
      .filter((i) => i.url && !/data:|blob:/.test(i.url));

    if (!videoSrc && images.length === 0) return null;

    const domNote: RawNote = {
      noteId,
      type: videoSrc ? 'video' : 'normal',
      title,
      desc: '',
      author,
      images,
      videos: videoSrc ? [{ url: videoSrc, backupUrls: [videoSrc], duration: undefined }] : [],
    };
    const info = noteToInfo(domNote, settings, location.href);
    info.source = 'dom';
    return info;
  }

  /* ---------------------------------------------------------------- */
  /* 主页扫描                                                          */
  /* ---------------------------------------------------------------- */

  async scanProfile(
    onProgress?: (info: { found: number; rounds: number }) => void,
  ): Promise<ProfileScan> {
    const { bridge, getSettings } = this.deps;
    const settings = getSettings();

    let rounds = 0;
    let refs = await this.collectRefs();
    onProgress?.({ found: refs.length, rounds });

    // 主页刚打开时列表还没渲染出来 —— 先等站点数据就绪，别急着下结论
    if (refs.length === 0) {
      await this.deps.bridge.waitForStateReady(6000);
      refs = await this.collectRefs();
      onProgress?.({ found: refs.length, rounds });
    }

    // 页面上明明有卡片，却一条笔记 id 都拿不到 —— 这是小红书未登录时的限制。
    // 再怎么滚也不会冒出 id，所以直接告诉用户，别让人对着转圈等半分钟。
    if (refs.length === 0 && this.countProfileCards() > 0) {
      const domCards = this.countProfileCards();
      return {
        refs: [],
        rounds,
        blocked: true,
        blockedReason: `小红书在未登录状态下不返回笔记 id（这个账号能看到 ${domCards} 张卡片，但拿不到内容地址）。登录后即可扫描完整列表并下载原始画质。`,
      };
    }

    if (settings.autoScrollScan) {
      const maxRounds = Math.max(1, settings.maxScrollRounds);
      let stagnant = 0;
      // 至少滚满 3 轮再判断「到底了」，否则页面还没加载完就提前收工
      while (rounds < maxRounds && (rounds < 3 || stagnant < 2)) {
        const before = refs.length;
        await this.scrollToBottom();
        await sleep(700);
        refs = await this.collectRefs();
        rounds += 1;
        stagnant = refs.length > before ? 0 : stagnant + 1;
        onProgress?.({ found: refs.length, rounds });
        if (refs.length >= 3000) break;
      }
    }

    // 借助站点自己的分页接口再翻几页（游客态下会被服务端截断，登录后才有完整数据）
    try {
      const res = await bridge.call<{ ok: boolean; notes?: any[] }>('profile.fetchMore', {
        rounds: Math.min(12, settings.maxScrollRounds),
      });
      if (res?.ok && Array.isArray(res.notes)) {
        refs = refs.concat(this.refsFromFeedItems(res.notes));
        rounds += 1;
        onProgress?.({ found: refs.length, rounds });
      }
    } catch {
      /* ignore */
    }

    // 合并去重
    const merged = new Map<string, RawNoteRef>();
    for (const ref of refs) {
      if (!ref.noteId) continue;
      const existing = merged.get(ref.noteId);
      if (!existing) {
        merged.set(ref.noteId, { ...ref, index: merged.size });
        continue;
      }
      merged.set(ref.noteId, {
        ...existing,
        xsecToken: existing.xsecToken ?? ref.xsecToken,
        title: existing.title ?? ref.title,
        cover: existing.cover ?? ref.cover,
        likedCount: existing.likedCount ?? ref.likedCount,
        type: existing.type === 'video' || ref.type === 'video' ? 'video' : 'normal',
      });
    }

    const result = Array.from(merged.values());

    // 一条都没拿到 id：小红书在未登录状态下不返回笔记 id（DOM 里的链接也只有 /explore/），
    // 登录后才能扫描完整列表并下载原始画质。
    if (result.length === 0) {
      const domCards = this.countProfileCards();
      return {
        refs: [],
        rounds,
        blocked: true,
        blockedReason:
          domCards > 0
            ? `小红书在未登录状态下不返回笔记 id（这个账号能看到 ${domCards} 张卡片，但拿不到内容地址）。登录后即可扫描完整列表并下载原始画质。`
            : '小红书在未登录状态下不返回笔记 id，登录后即可扫描该账号的全部笔记并下载原始画质。',
      };
    }

    return { refs: result, rounds };
  }

  /** 主页上渲染出来的笔记卡片数量（用来区分「账号没笔记」和「游客态受限」） */
  private countProfileCards(): number {
    return document.querySelectorAll('section.note-item, .note-item, [data-note-id]').length;
  }

  /** 汇总三路来源：state / 站点 API 响应 / DOM */
  private async collectRefs(): Promise<RawNoteRef[]> {
    const { bridge } = this.deps;
    const out: RawNoteRef[] = [];

    try {
      const res = await bridge.call<{ refs: RawNoteRef[] }>('state.userNotes');
      if (res?.refs) out.push(...res.refs);
    } catch {
      /* ignore */
    }

    try {
      const captured = await bridge.call<Array<{ url: string; body: any }>>('api.captured');
      for (const entry of captured ?? []) {
        if (!/user_posted/.test(entry.url)) continue;
        const notes = entry.body?.data?.notes;
        if (!Array.isArray(notes)) continue;
        for (const n of notes) {
          const card = isObj(n?.note_card) ? n.note_card : n;
          const noteId = str(n?.id) || str(n?.note_id) || str(card?.note_id);
          if (!noteId) continue;
          out.push({
            noteId,
            xsecToken: str(n?.xsec_token) || str(card?.xsec_token) || undefined,
            title: str(card?.display_title) || undefined,
            type: str(card?.type) === 'video' ? 'video' : 'normal',
            cover:
              str(card?.cover?.url_default) || str(card?.cover?.urlDefault) || str(card?.cover) || undefined,
            likedCount: num(card?.interact_info?.liked_count ?? card?.interactInfo?.likedCount),
          });
        }
      }
    } catch {
      /* ignore */
    }

    out.push(...this.scanProfileDom());
    return out;
  }

  /** Pinia store 里喂给我们的 feed item（与发现页结构一致） */
  private refsFromFeedItems(items: any[]): RawNoteRef[] {
    const out: RawNoteRef[] = [];
    for (const item of items) {
      if (!isObj(item)) continue;
      const card = isObj(item.noteCard) ? item.noteCard : isObj(item.note_card) ? item.note_card : item;
      const noteId = str(item.id) || str(item.noteId) || str(card.noteId);
      if (!noteId) continue;
      out.push({
        noteId,
        xsecToken: str(item.xsecToken) || str(item.xsec_token) || undefined,
        title: str(card.displayTitle) || str(card.display_title) || undefined,
        type: str(card.type) === 'video' ? 'video' : 'normal',
        cover: str(card.cover?.urlDefault) || str(card.cover?.url_default) || undefined,
        likedCount: num(card.interactInfo?.likedCount ?? card.interact_info?.liked_count),
      });
    }
    return out;
  }

  /** 从 DOM 抓主页 grid：主要作用是拿到 xsec_token 与笔记类型 */
  private scanProfileDom(): RawNoteRef[] {
    const out: RawNoteRef[] = [];
    const nodes = document.querySelectorAll('section.note-item, .note-item, [data-note-id]');
    nodes.forEach((node) => {
      const anchor = node.matches('a')
        ? (node as HTMLAnchorElement)
        : node.querySelector<HTMLAnchorElement>('a[href*="/explore/"]');
      const href = anchor?.getAttribute('href') ?? '';
      const noteId =
        href.match(/\/explore\/([A-Za-z0-9_-]+)/i)?.[1] ??
        node.getAttribute('data-note-id') ??
        '';
      if (!noteId) return;
      const xsecToken = href.match(/[?&]xsec_token=([^&]+)/i)?.[1];
      const isVideo =
        /video/i.test(node.className ?? '') ||
        Boolean(node.querySelector('[class*="play"], [class*="video"], svg[class*="play"]'));
      const img = node.querySelector('img');
      const cover = img?.getAttribute('src') ?? undefined;
      out.push({
        noteId,
        xsecToken,
        type: isVideo ? 'video' : 'normal',
        cover: cover ? cover.replace(/^http:\/\//, 'https://') : undefined,
      });
    });
    return out;
  }

  /** 小红书的主页是内层滚动容器（.reds-lock-scroll），滚 window 无效 */
  private async scrollToBottom(): Promise<void> {
    const scrollers = [
      document.querySelector('.reds-lock-scroll'),
      document.querySelector('#userPostedFeeds'),
      document.querySelector('.feeds-container'),
      document.querySelector('#noteContainer'),
      document.scrollingElement,
    ].filter(Boolean) as Element[];

    for (const el of scrollers) {
      el.scrollTop = el.scrollHeight;
    }
    window.scrollTo(0, document.body.scrollHeight);
  }

  /* ---------------------------------------------------------------- */
  /* 主页笔记详情解析                                                  */
  /* ---------------------------------------------------------------- */

  /**
   * 解析主页里某条笔记的媒体资源。
   * 返回 null 表示还没解析出来（调用方可以重试）。
   *
   * 两条路：
   *   1. 页面状态 —— 主页已经预加载过的笔记直接命中，零开销
   *   2. api.noteDetail —— 走 iframe 加载真实笔记页（实测单条 ~370ms）
   */
  async resolveNoteDetail(
    ref: RawNoteRef,
  ): Promise<{ info: NoteInfo; items: MediaItem[] } | null> {
    const { bridge, getSettings } = this.deps;
    const settings = getSettings();

    let raw: RawNote | null = null;
    let source: NoteInfo['source'] = 'api';

    // 1) 页面状态里已经有这条笔记的话，直接用（必须 id 对得上）
    try {
      const res = await bridge.call<{ note: RawNote | null }>('state.note', {
        noteId: ref.noteId,
      });
      if (res?.note && res.note.noteId === ref.noteId) {
        raw = res.note;
        source = 'initial-state';
      }
    } catch {
      /* ignore */
    }

    // 2) 否则让页面自己加载这篇笔记
    if (!raw) {
      try {
        const res = await bridge.call<{ ok: boolean; note?: RawNote; error?: string }>(
          'api.noteDetail',
          {
            noteId: ref.noteId,
            xsecToken: ref.xsecToken,
          },
        );
        if (res?.ok && res.note) raw = res.note;
      } catch {
        /* ignore */
      }
    }

    if (!raw) return null;

    // 标题只有一个来源：笔记详情里的标题优先，拿不到就用列表卡片上的标题
    // （推荐流的 displayTitle 比笔记详情可靠 —— 有一部分笔记详情里的 title 是空串）。
    // 关键是「面板显示什么，文件名就是什么」：以前两者各算各的，
    // 结果面板上是正常标题，落盘的文件名却是一串笔记编号。
    const title = (raw.title || ref.title || '').trim();

    const info = noteToInfo(raw, settings, `https://www.xiaohongshu.com/explore/${ref.noteId}`, title);
    info.author = info.author || '';
    info.cover = info.cover || ref.cover;
    info.source = source;
    return { info, items: noteToMediaItems(raw, settings, title) };
  }
}

export { shortId, unref };
