import type {
  DownloadProgress,
  MediaFilter,
  MediaItem,
  NoteFilter,
  NoteInfo,
  SaveStructure,
  Settings,
  TaskSummary,
} from '../../shared/types';
import {
  filterByMediaFilter,
  formatBytes,
  formatDuration,
  formatSpeed,
  mediaFilterLabel,
  sanitizeSegment,
  saveStructureLabel,
  saveStructureName,
} from '../../shared/utils';
import { icon, logoSvg } from './icons';
import { fileNameForItem } from '../detect/media';
import { STYLES } from './styles';

/* ------------------------------------------------------------------ */
/* 类型                                                                */
/* ------------------------------------------------------------------ */

export interface BatchCard {
  noteId: string;
  title: string;
  type: 'video' | 'image';
  cover?: string;
  likedCount?: number;
  /** 解析出的媒体数量；扫描阶段未知 */
  mediaCount?: number;
  resolved: boolean;
  /** 正在解析媒体资源 */
  resolving?: boolean;
  /** 解析失败 —— 必须让用户看见，不能静默跳过 */
  failed?: boolean;
  /** 该卡片下的下载项 id 列表 */
  itemIds: string[];
}

export type BatchPhase = 'scanning' | 'ready' | 'blocked' | 'error' | 'completed';

export interface NoteViewModel {
  note: NoteInfo | null;
  detecting: boolean;
  error?: string;
  progress: Map<string, DownloadProgress>;
  /** 文件类型筛选：决定列表与「全部下载」的范围 */
  mediaFilter: MediaFilter;
  /** 保存结构：每篇笔记一个独立文件夹，还是全部放进主文件夹 */
  saveStructure: SaveStructure;
}

export interface BatchViewModel {
  nickname?: string;
  avatar?: string;
  phase: BatchPhase;
  scanInfo?: { found: number; rounds: number };
  /**
   * 这一批内容是用哪条路解析出来的。
   *
   * 'iframe' —— 隐藏 iframe 读页面渲染后的状态（和 1.0.0 一样，最权威）
   * 'fetch'  —— 抓笔记页的 HTML（更快，但必须先证明与页面渲染结果一致才用）
   * 'api'    —— 页面自己抓到的接口响应（站点只肯用接口发详情时走这条）
   *
   * 显示出来是有原因的：几条路给的东西**可能不一样**，
   * 用户一眼就能看出这批是不是按页面看到的样子下的。
   */
  parsePath?: 'iframe' | 'fetch' | 'api';
  /** 这一场实际用过的路（几条都用过就都记上） */
  parsePaths?: Array<'iframe' | 'fetch' | 'api'>;
  /** 快路是否被证明与页面渲染结果一致（一致了才敢让它接手） */
  parseTrusted?: boolean;
  cards: BatchCard[];
  /** 笔记类型筛选：只影响卡片列表 */
  noteFilter: NoteFilter;
  /** 文件类型筛选：只影响「下载哪些文件」，不影响卡片列表 */
  mediaFilter: MediaFilter;
  /** 保存结构：只影响落盘目录，不影响卡片列表 */
  saveStructure: SaveStructure;
  selected: Set<string>;
  progress: Map<string, DownloadProgress>;
  summary?: TaskSummary;
  error?: string;
  resolving: boolean;
  /** 批量解析进度 */
  resolveInfo?: { done: number; total: number; failed: number };
}

export interface PanelCallbacks {
  onDownloadItems(items: MediaItem[]): void;
  onCopyLink(url: string): void;
  onScan(): void;
  onStopScan(): void;
  onRescan(): void;
  onRetry(itemId: string): void;
  onCancelTask(): void;
  onOpenDownloads(): void;
  onOpenOptions(): void;
  onLogin(): void;
  onResolveSelection(selectedNoteIds: string[]): void;
  /** 文件类型筛选变了（只下载视频 / 只下载图片） */
  onMediaFilterChange(filter: MediaFilter): void;
  /** 保存结构变了（独立文件夹 / 统一文件夹） */
  onSaveStructureChange(structure: SaveStructure): void;
  /** 主按钮被点击。宿主决定是「开面板」还是「直接开始扫描」 */
  onFabClick?(): void;
}

/* ------------------------------------------------------------------ */
/* 工具                                                                */
/* ------------------------------------------------------------------ */

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  html?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (html !== undefined) node.innerHTML = html;
  return node;
}

function percent(progress: DownloadProgress): number | null {
  if (progress.totalBytes > 0) {
    return Math.min(100, Math.round((progress.bytesReceived / progress.totalBytes) * 100));
  }
  return null;
}

/** 单篇笔记里某个资源行的状态文案 */
function rowStatusHtml(item: MediaItem, progress?: DownloadProgress): string {
  const state = progress?.state ?? 'idle';
  if (state === 'downloading') {
    const pct = percent(progress!);
    return pct !== null
      ? `${pct}% · ${formatBytes(progress!.bytesReceived)} / ${formatBytes(progress!.totalBytes)}`
      : `${formatBytes(progress!.bytesReceived)}`;
  }
  if (state === 'retrying') {
    // 自动重试中：让用户看到「在处理」而不是一个卡住的进度条
    return '<span class="rn-retrying">网络异常，正在重试…</span>';
  }
  if (state === 'waiting') {
    // 等用户选保存目录：说清楚在等什么，不然看着像卡住了
    return '<span class="rn-retrying">等你选好保存目录…</span>';
  }
  if (state === 'completed') {
    return `已保存${progress?.totalBytes ? ` · ${formatBytes(progress.totalBytes)}` : ''}`;
  }
  if (state === 'failed') {
    return `<span class="rn-err">下载失败</span>${progress?.error ? ` · ${progress.error}` : ''}`;
  }
  if (item.isStream) {
    return '<span class="rn-err">HLS 流</span> · 暂不支持直接保存';
  }
  const bits: string[] = [];
  if (item.size) bits.push(formatBytes(item.size));
  if (item.width && item.height) bits.push(`${item.width}×${item.height}`);
  if (item.kind === 'video' && item.duration) bits.push(formatDuration(item.duration));
  return bits.join(' · ') || '大小未知';
}

/** 主页卡片上的状态文案 */
function cardStatusHtml(progress?: DownloadProgress): string {
  const state = progress?.state ?? 'idle';
  if (state === 'downloading') {
    const pct = percent(progress!) ?? 0;
    return `${pct}% · ${formatBytes(progress!.bytesReceived)}${progress!.speed ? ` · ${formatSpeed(progress!.speed)}` : ''}`;
  }
  if (state === 'completed') return '<span class="rn-ok">已完成</span>';
  if (state === 'failed') return '<span class="rn-err">下载失败</span>';
  if (state === 'retrying') return `<span class="rn-resolving">${icon('spinner', 11)}重试中…</span>`;
  if (state === 'waiting') return '<span class="rn-resolving">等你选目录</span>';
  if (state === 'queued') return '排队中';
  return '';
}

/** 笔记页里一行资源的可更新节点 */
interface NoteRowRefs {
  row: HTMLElement;
  item: MediaItem;
  meta: HTMLElement;
  bar: HTMLElement;
  fill: HTMLElement;
  action: HTMLElement;
  done: HTMLElement;
  /** 上一次的状态，用来判断右侧操作区要不要重建 */
  state: string;
  /** 下载中的百分比标签 */
  pct?: HTMLElement;
}

/** 主页里一张卡片的可更新节点 */
interface BatchCardRefs {
  node: HTMLElement;
  card: BatchCard;
  imgWrap: HTMLElement;
  meta: HTMLElement;
  state: string;
}

const RING_R = 11;
const RING_C = 2 * Math.PI * RING_R;

/**
 * 这一批内容是怎么解析出来的，写成一行小字。
 *
 * 「页面渲染」= 隐藏 iframe 读页面渲染后的状态（1.0.0 就是这么干的，最权威）
 * 「快路」    = 抓笔记页的 HTML —— 只有在跟页面渲染的结果**逐条比对过完全一致**
 *              之后才敢用它（否则宁可慢，也不能下到不一样的东西）
 * 「兜底抓取」= 页面没给出资源时临时抓一次 HTML 救场，没有可比对的基准
 * 「接口响应」= 站点只肯用接口发详情时，走页面自己抓到的接口响应
 */
function describeParsePaths(
  paths: Array<'iframe' | 'fetch' | 'api'>,
  trusted?: boolean,
): string {
  const frame = paths.includes('iframe');
  const fast = paths.includes('fetch');
  const api = paths.includes('api');
  if (frame && api) return ' · 页面渲染 + 接口响应';
  if (api) return ' · 接口响应（页面自己抓到的详情）';
  if (frame && fast) {
    return trusted ? ' · 页面渲染 + 快路（已核对与页面一致）' : ' · 页面渲染 + 兜底抓取';
  }
  if (fast) return trusted ? ' · 快路（已核对与页面一致）' : ' · 兜底抓取';
  if (frame) return ' · 页面渲染';
  return '';
}

/** 进度环的缺口：百分比越满，缺口越小 */
function ringOffset(pct: number): number {
  return RING_C * (1 - pct / 100);
}

function ringSvg(pct: number): string {
  const offset = ringOffset(pct);
  return `<svg class="rn-ring" width="28" height="28" viewBox="0 0 28 28">
    <circle class="track" cx="14" cy="14" r="${RING_R}" fill="none" stroke-width="2.5"/>
    <circle class="bar" cx="14" cy="14" r="${RING_R}" fill="none" stroke-width="2.5"
      stroke-dasharray="${RING_C.toFixed(2)}" stroke-dashoffset="${offset.toFixed(2)}"/>
  </svg>`;
}

/* ------------------------------------------------------------------ */
/* 面板                                                                */
/* ------------------------------------------------------------------ */

export class Panel {
  /** 主页头部的两行文字：只改文字，不重建网格时用 */
  private batchHeadTitle?: HTMLElement;
  private batchHeadSub?: HTMLElement;

  private host!: HTMLElement;
  private shadow!: ShadowRoot;
  private fab!: HTMLButtonElement;
  private fabBadge!: HTMLElement;
  private fabLabel!: HTMLElement;
  private fabRing!: SVGSVGElement;
  private panel!: HTMLElement;
  private header!: HTMLElement;
  private body!: HTMLElement;
  private footer!: HTMLElement;
  private toolbar!: HTMLElement;
  private grabber!: HTMLElement;

  private mode: 'note' | 'batch' = 'note';
  private isOpen = false;
  private callbacks: PanelCallbacks;
  private settings: Settings;

  /** itemId → 所属卡片 noteId（批量模式用） */
  private itemToCard = new Map<string, string>();
  private collapsed = new Set<string>();

  /**
   * 进度更新时要改的节点。
   *
   * 进度每秒变好几次，如果每次都整块重画，几十张卡片的缩略图会被反复
   * 销毁重建 —— 图片要重新解码，主线程直接卡住。这里把节点留住，
   * 只改变化的那几行 / 那几张卡。
   */
  private noteRows = new Map<string, NoteRowRefs>();
  private cardNodes = new Map<string, BatchCardRefs>();

  constructor(callbacks: PanelCallbacks, settings: Settings) {
    this.callbacks = callbacks;
    this.settings = settings;
  }

  /* ---------------------------- 挂载 ---------------------------- */

  mount(): void {
    this.host = document.createElement('rednote-root');
    this.host.setAttribute('data-theme', this.resolveTheme());
    this.shadow = this.host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = STYLES;
    this.shadow.appendChild(style);

    const root = el('div', 'rn-root');
    this.shadow.appendChild(root);

    // FAB
    this.fab = el('button', 'rn-fab');
    this.fab.type = 'button';
    this.fab.setAttribute('aria-label', '下载当前页面的内容');
    this.fab.innerHTML = `${icon('download', 22)}<span class="rn-fab-label">下载</span>
      <svg class="rn-fab-progress" viewBox="0 0 48 48" width="48" height="48" hidden>
        <circle class="track" cx="24" cy="24" r="22"/><circle class="bar" cx="24" cy="24" r="22"/>
      </svg>
      <span class="rn-fab-badge" data-badge="0">0</span>`;
    this.fabBadge = this.fab.querySelector('.rn-fab-badge')!;
    this.fabLabel = this.fab.querySelector('.rn-fab-label')!;
    this.fabRing = this.fab.querySelector('.rn-fab-progress')!;
    this.fab.addEventListener('click', () => {
      if (this.callbacks.onFabClick) {
        this.callbacks.onFabClick();
        return;
      }
      this.toggle();
    });
    root.appendChild(this.fab);

    // 面板
    this.panel = el('aside', 'rn-panel');
    this.panel.setAttribute('role', 'dialog');
    this.panel.setAttribute('aria-modal', 'false');
    this.panel.dataset.mode = 'note';
    this.panel.dataset.open = 'false';

    this.grabber = el('div', 'rn-grabber');
    this.panel.appendChild(this.grabber);

    this.header = el('header', 'rn-header');
    this.panel.appendChild(this.header);

    this.toolbar = el('div', 'rn-toolbar');
    this.toolbar.hidden = true;
    this.panel.appendChild(this.toolbar);

    this.body = el('div', 'rn-body');
    this.panel.appendChild(this.body);

    this.footer = el('footer', 'rn-footer');
    this.footer.hidden = true;
    this.panel.appendChild(this.footer);

    root.appendChild(this.panel);

    document.documentElement.appendChild(this.host);

    // 外部点击关闭
    document.addEventListener(
      'pointerdown',
      (event) => {
        if (!this.isOpen) return;
        const path = event.composedPath();
        if (path.includes(this.host)) return;
        this.close();
      },
      true,
    );

    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && this.isOpen) {
        event.stopPropagation();
        this.close();
        this.fab.focus();
      }
    });

    window.addEventListener('resize', () => this.position());
    window.addEventListener('scroll', () => this.position(), { passive: true });
  }

  destroy(): void {
    this.host.remove();
  }

  get shadowRoot(): ShadowRoot {
    return this.shadow;
  }

  /** 重绘时保持滚动位置，避免进度更新把列表弹回顶部 */
  private preserveScroll(render: () => void): void {
    const top = this.body.scrollTop;
    render();
    this.body.scrollTop = top;
  }

  private resolveTheme(): string {
    if (this.settings.theme === 'dark') return 'dark';
    if (this.settings.theme === 'light') return 'light';
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }

  setTheme(theme: Settings['theme']): void {
    this.settings = { ...this.settings, theme };
    this.host.setAttribute('data-theme', this.resolveTheme());
  }

  /** 设置变了（命名模板、保存结构…）—— 文件名要跟着重算 */
  setSettings(settings: Settings): void {
    this.settings = settings;
  }

  /* ---------------------------- 开合 ---------------------------- */

  toggle(): void {
    if (this.isOpen) this.close();
    else this.open();
  }

  open(): void {
    this.isOpen = true;
    this.panel.dataset.open = 'true';
    this.fab.dataset.hidden = 'true';
    this.position();
    const closeBtn = this.header.querySelector('.rn-icon-btn') as HTMLElement | null;
    closeBtn?.focus({ preventScroll: true });
  }

  close(): void {
    this.isOpen = false;
    this.panel.dataset.open = 'false';
    this.fab.dataset.hidden = 'false';
  }

  get isPanelOpen(): boolean {
    return this.isOpen;
  }

  /* ---------------------------- 定位 ---------------------------- */

  private position(): void {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const contentRect = this.findContentRect();
    const asideRect = this.findAsideRect();

    let fabRight = 24;
    if (vw < 768) {
      fabRight = 16;
    } else if (asideRect) {
      const gap = vw - asideRect.left;
      fabRight = gap >= 96 ? vw - asideRect.left + 24 : 24;
    } else if (contentRect) {
      fabRight = Math.max(16, vw - contentRect.right + 24);
    }

    this.fab.style.right = `${fabRight}px`;
    this.fab.style.bottom = vw < 768 ? '16px' : '88px';

    if (this.mode === 'batch') {
      const width = 480;
      const overlapsContent =
        contentRect !== undefined && vw - width < contentRect.right + 120;
      const panelMode =
        vw < 768 ? 'full' : overlapsContent && vw < 1440 ? 'drawer' : 'batch';
      this.panel.dataset.mode = panelMode;
      this.panel.style.right = panelMode === 'batch' ? '24px' : '';
      this.panel.style.left = panelMode === 'drawer' ? '16px' : '';
      this.panel.style.top = panelMode === 'batch' ? '76px' : '';
      this.panel.style.bottom = panelMode === 'batch' ? '24px' : '';
    } else {
      this.panel.dataset.mode = 'note';
      this.panel.style.right = `${fabRight}px`;
      this.panel.style.bottom = `${vh < 560 ? 76 : 148}px`;
      this.panel.style.top = '';
      this.panel.style.left = '';
    }
  }

  private findContentRect(): DOMRect | undefined {
    const selectors = [
      '#noteContainer',
      '.note-container',
      '#userPostedFeeds',
      '.feeds-container',
      '.note-detail-container',
      'main',
    ];
    for (const selector of selectors) {
      const node = document.querySelector(selector);
      if (node) {
        const rect = node.getBoundingClientRect();
        if (rect.width > 200 && rect.height > 100) return rect;
      }
    }
    return undefined;
  }

  private findAsideRect(): DOMRect | undefined {
    const selectors = [
      '.recommend-container',
      '.right-recommend-container',
      '.right-recommend',
      '.recommend-list',
      '#recommendContainer',
    ];
    for (const selector of selectors) {
      const node = document.querySelector(selector);
      if (node) {
        const rect = node.getBoundingClientRect();
        if (rect.width > 100 && rect.left > window.innerWidth * 0.5) return rect;
      }
    }
    // 视口足够宽时，按小红书桌面端布局推断右侧推荐栏宽度
    if (window.innerWidth >= 1440) {
      const left = window.innerWidth - 360;
      return new DOMRect(left, 0, 360, window.innerHeight);
    }
    return undefined;
  }

  /* ---------------------------- 渲染 ---------------------------- */

  setMode(mode: 'note' | 'batch'): void {
    this.mode = mode;
    this.position();
  }

  /** 渲染单篇面板 */
  renderNote(vm: NoteViewModel): void {
    this.preserveScroll(() => this.renderNoteInner(vm));
  }

  private renderNoteInner(vm: NoteViewModel): void {
    this.mode = 'note';
    this.toolbar.hidden = false;
    this.footer.hidden = false;
    this.noteRows.clear();

    this.header.innerHTML = '';
    const text = el('div', 'rn-head-text');
    const title = el('div', 'rn-head-title');
    title.id = 'rn-panel-title';
    title.textContent = vm.note?.title || (vm.detecting ? '正在识别当前内容…' : '当前页面');
    const sub = el('div', 'rn-head-sub');
    // 头部描述的是「现在能下什么」，所以要跟着筛选走 ——
    // 列表里只剩视频，头部却还写着「1 张图片」，用户会以为漏了
    const visibleItems = vm.note ? filterByMediaFilter(vm.note.items, vm.mediaFilter) : [];
    sub.textContent = vm.note
      ? describeNote(vm.note, visibleItems)
      : vm.detecting
        ? '请稍候'
        : '没有识别到可下载的内容';
    text.append(title, sub);
    this.header.append(text);
    this.header.append(this.buildHeadActions());

    this.renderNoteToolbar(vm.mediaFilter, vm.saveStructure);

    this.body.innerHTML = '';

    // 重新识别同一篇笔记时不要把内容换成骨架屏 ——
    // 用户正要点的下载按钮会突然消失，那就是一次静默无响应
    if (vm.detecting && !vm.note) {
      this.body.appendChild(this.buildScanState('正在识别当前笔记…', '正在读取页面中的图片与视频信息'));
      return;
    }
    if (vm.error && !vm.note) {
      this.body.appendChild(
        this.buildEmptyState({
          title: '没有识别到可下载的内容',
          body: vm.error,
          actions: [
            { label: '重新识别', variant: 'primary', onClick: () => this.callbacks.onRescan() },
          ],
        }),
      );
      return;
    }
    if (!vm.note || vm.note.items.length === 0) {
      this.body.appendChild(
        this.buildEmptyState({
          title: '没有识别到可下载的内容',
          body: '这条笔记可能只有文字，或者需要登录后才能查看原始图片与视频。',
          actions: [
            { label: '登录小红书', variant: 'primary', onClick: () => this.callbacks.onLogin() },
          ],
        }),
      );
      return;
    }

    const allItems = vm.note.items;
    const items = filterByMediaFilter(allItems, vm.mediaFilter);
    const videos = items.filter((i) => i.kind === 'video');
    const images = items.filter((i) => i.kind === 'image');

    if (videos.length > 0) {
      this.body.appendChild(
        this.buildSection('视频', videos, vm.progress, 'video'),
      );
    }
    if (images.length > 0) {
      this.body.appendChild(this.buildSection('图片', images, vm.progress, 'image'));
    }
    if (videos.length === 0 && images.length === 0) {
      // 筛选把内容全排除了 —— 说清楚原因，并给一个立刻能点的出口，
      // 否则用户只会看到空白面板，不知道该往哪点
      this.body.appendChild(
        this.buildEmptyState({
          title: '当前筛选下没有可下载的文件',
          body: `这篇笔记有 ${allItems.length} 个资源，但都被「只下载${mediaFilterLabel(vm.mediaFilter)}」筛掉了。`,
          actions: [
            {
              label: '改为下载全部',
              variant: 'primary',
              onClick: () => this.callbacks.onMediaFilterChange('all'),
            },
          ],
        }),
      );
    }

    this.renderNoteFooter(vm);
  }

  private buildSection(
    label: string,
    items: MediaItem[],
    progress: Map<string, DownloadProgress>,
    kind: 'video' | 'image',
  ): HTMLElement {
    const section = el('section', 'rn-section');
    const key = `note:${kind}`;
    const head = el('button', 'rn-section-head');
    head.type = 'button';
    head.setAttribute('aria-expanded', this.collapsed.has(key) ? 'false' : 'true');
    head.innerHTML = `<span class="rn-caret">${icon('chevronDown', 14)}</span>
      <span>${label}</span><span class="rn-count">${items.length}</span>`;
    head.addEventListener('click', () => {
      if (this.collapsed.has(key)) this.collapsed.delete(key);
      else this.collapsed.add(key);
      this.renderNote(this.lastNoteVm!);
    });
    section.appendChild(head);

    if (!this.collapsed.has(key)) {
      const list = el('div', 'rn-list');
      for (const item of items) {
        list.appendChild(this.buildRow(item, progress.get(item.id)));
      }
      section.appendChild(list);
    }
    return section;
  }

  private buildRow(item: MediaItem, progress?: DownloadProgress): HTMLElement {
    const row = el('div', 'rn-row');
    const state = progress?.state ?? 'idle';
    // 挂上类型，方便排障与自动化检查
    row.dataset.kind = item.kind;

    const thumb = el('div', 'rn-thumb');
    if (item.thumbUrl) {
      const img = document.createElement('img');
      img.src = item.thumbUrl;
      img.alt = '';
      img.loading = 'lazy';
      thumb.appendChild(img);
    }
    if (item.kind === 'video') {
      const play = el('div', 'rn-thumb-play');
      play.innerHTML = icon('play', 14);
      thumb.appendChild(play);
    }
    // 完成角标常驻，用 hidden 切换 ——
    // 进度更新时不必重建这一行，缩略图也不用重新解码
    const done = el('div', 'rn-thumb-done');
    done.innerHTML = icon('check', 9);
    done.hidden = state !== 'completed';
    thumb.appendChild(done);
    row.appendChild(thumb);

    const main = el('div', 'rn-row-main');
    const name = el('div', 'rn-row-name');
    // 文件名随设置变（命名模板、保存结构），这里现算，
    // 保证面板上看到的名字就是落盘的名字
    name.textContent = fileNameForItem(this.settings, item);
    main.appendChild(name);

    const meta = el('div', 'rn-row-meta');
    main.appendChild(meta);

    // 进度条也常驻，用 hidden 切换
    const bar = el('div', 'rn-row-bar');
    const fill = el('i');
    bar.appendChild(fill);
    bar.hidden = state !== 'downloading';
    main.appendChild(bar);

    row.appendChild(main);

    // 右侧操作区：位置固定，内容随状态变。
    // 外壳是 display:contents，布局跟以前完全一样。
    const action = el('div', 'rn-row-action');
    row.appendChild(action);

    const refs: NoteRowRefs = { row, item, meta, bar, fill, action, done, state: '' };
    this.noteRows.set(item.id, refs);
    this.paintRow(refs, progress);
    return row;
  }

  /** 把进度画到行上（整块渲染与增量更新共用这一份逻辑） */
  private paintRow(refs: NoteRowRefs, progress?: DownloadProgress): void {
    const item = refs.item;
    const state = progress?.state ?? 'idle';
    if (progress) refs.row.dataset.state = state;
    else delete refs.row.dataset.state;

    refs.meta.innerHTML = rowStatusHtml(item, progress);

    const downloading = state === 'downloading';
    refs.bar.hidden = !downloading;
    refs.done.hidden = state !== 'completed';
    if (downloading) {
      const pct = percent(progress!) ?? 0;
      refs.fill.style.width = `${pct}%`;
    }

    if (refs.state !== state) {
      // 只有状态变了才重建右侧操作区
      refs.state = state;
      this.fillRowAction(refs, progress);
    } else if (downloading && refs.pct) {
      // 进度数字原地更新
      const pct = percent(progress!);
      refs.pct.textContent = pct !== null ? `${pct}%` : '…';
    }
  }

  /** 行右侧的操作区：下载按钮 / 进度数字 / 重试按钮 */
  private fillRowAction(refs: NoteRowRefs, progress?: DownloadProgress): void {
    const item = refs.item;
    const action = refs.action;
    action.innerHTML = '';
    refs.pct = undefined;
    const state = progress?.state ?? 'idle';

    if (state === 'downloading') {
      const pct = percent(progress!);
      const label = el('div', 'rn-row-pct');
      label.textContent = pct !== null ? `${pct}%` : '…';
      action.appendChild(label);
      refs.pct = label;
    } else if (state === 'retrying') {
      // 自动重试中：让用户看到「在处理」而不是一个卡住的进度条
      const label = el('div', 'rn-row-pct');
      label.innerHTML = icon('spinner', 14);
      label.classList.add('rn-spin');
      action.appendChild(label);
    } else if (state === 'completed') {
      const btn = el('button', 'rn-btn');
      btn.type = 'button';
      btn.dataset.variant = 'text';
      btn.setAttribute('aria-label', `打开浏览器下载列表：${item.filename}`);
      btn.innerHTML = icon('folder', 15);
      btn.addEventListener('click', () => this.callbacks.onOpenDownloads());
      action.appendChild(btn);
    } else if (state === 'failed') {
      const btn = el('button', 'rn-btn');
      btn.type = 'button';
      btn.dataset.variant = 'text';
      btn.innerHTML = `${icon('retry', 14)}重试`;
      btn.addEventListener('click', () => this.callbacks.onRetry(item.id));
      action.appendChild(btn);
    } else if (item.isStream) {
      const btn = el('button', 'rn-btn');
      btn.type = 'button';
      btn.dataset.variant = 'text';
      btn.innerHTML = '查看原因';
      btn.addEventListener('click', () => this.callbacks.onCopyLink(item.url));
      action.appendChild(btn);
    } else {
      const btn = el('button', 'rn-btn');
      btn.type = 'button';
      btn.innerHTML = icon('download', 15);
      btn.setAttribute('aria-label', `下载 ${item.filename}`);
      btn.addEventListener('click', () => this.callbacks.onDownloadItems([item]));
      action.appendChild(btn);
    }
  }

  /* ---------------------------- 工具条 ---------------------------- */

  /** 笔记页工具条：文件类型筛选 + 保存结构 */
  private renderNoteToolbar(current: MediaFilter, structure: SaveStructure): void {
    this.toolbar.innerHTML = '';
    const row = el('div', 'rn-toolbar-row');
    row.appendChild(this.buildMediaFilter(current));
    this.toolbar.appendChild(row);

    const structureRow = el('div', 'rn-toolbar-row');
    structureRow.appendChild(this.buildSaveStructure(structure));
    this.toolbar.appendChild(structureRow);
  }

  /**
   * 文件类型筛选控件（笔记页与主页批量页共用）。
   *
   * 语义是「下载哪些文件」，所以标签写「下载内容」——
   * 主页工具条里还有一组按笔记类型筛选的页签，两者含义不同，必须区分开。
   */
  private buildMediaFilter(current: MediaFilter): HTMLElement {
    const group = el('div', 'rn-filter');
    const label = el('span', 'rn-filter-label');
    label.textContent = '下载内容';
    group.appendChild(label);

    const seg = el('div', 'rn-tabs');
    seg.setAttribute('role', 'tablist');
    seg.setAttribute('aria-label', '按文件类型筛选下载内容');
    const defs: Array<[MediaFilter, string]> = [
      ['all', '全部'],
      ['video', '视频'],
      ['image', '图片'],
    ];
    for (const [key, text] of defs) {
      const tab = el('button', 'rn-tab rn-tab-media');
      tab.type = 'button';
      tab.setAttribute('role', 'tab');
      tab.setAttribute('aria-selected', String(current === key));
      tab.textContent = text;
      tab.addEventListener('click', () => this.callbacks.onMediaFilterChange(key));
      seg.appendChild(tab);
    }
    group.appendChild(seg);
    return group;
  }

  /**
   * 保存结构控件（笔记页与主页批量页共用）。
   *
   * 决定文件落在哪种目录里，跟「下载哪些文件」是两件事，所以单独一组。
   */
  private buildSaveStructure(current: SaveStructure): HTMLElement {
    const group = el('div', 'rn-filter');
    const label = el('span', 'rn-filter-label');
    label.textContent = '保存结构';
    group.appendChild(label);

    const seg = el('div', 'rn-tabs');
    seg.setAttribute('role', 'tablist');
    seg.setAttribute('aria-label', '选择文件保存结构');
    const defs: Array<[SaveStructure, string, string]> = [
      ['perNote', '按笔记', '每篇笔记一个文件夹：作者/标题/文件名'],
      ['perAuthor', '按作者', '同一作者的内容放一个文件夹：作者/文件名'],
      ['flat', '全部平铺', '所有文件平铺在主文件夹里，靠文件名区分'],
    ];
    for (const [key, text, tip] of defs) {
      const tab = el('button', 'rn-tab rn-tab-structure');
      tab.type = 'button';
      tab.setAttribute('role', 'tab');
      tab.setAttribute('aria-selected', String(current === key));
      tab.textContent = text;
      tab.title = tip;
      tab.addEventListener('click', () => this.callbacks.onSaveStructureChange(key));
      seg.appendChild(tab);
    }
    group.appendChild(seg);
    return group;
  }

  private renderNoteFooter(vm: NoteViewModel): void {
    this.footer.innerHTML = '';
    const info = el('div', 'rn-footer-info');
    const title = el('div', 'rn-footer-title');
    const sub = el('div', 'rn-footer-sub');

    const all = vm.note?.items ?? [];
    const items = filterByMediaFilter(all, vm.mediaFilter);
    const skipped = all.length - items.length;
    const active = items.filter((i) => {
      const p = vm.progress.get(i.id);
      return p?.state === 'downloading' || p?.state === 'queued' || p?.state === 'retrying';
    });
    const done = items.filter((i) => vm.progress.get(i.id)?.state === 'completed');
    const failed = items.filter((i) => vm.progress.get(i.id)?.state === 'failed');

    if (active.length > 0) {
      title.textContent = `下载中 ${done.length + failed.length} / ${items.length}`;
      const totalBytes = items.reduce((sum, i) => sum + (i.size ?? 0), 0);
      const gotBytes = items.reduce((sum, i) => sum + (vm.progress.get(i.id)?.bytesReceived ?? 0), 0);
      const pct = totalBytes > 0 ? Math.round((gotBytes / totalBytes) * 100) : 0;
      sub.textContent = `${pct}% · 成功 ${done.length}${failed.length ? ` · 失败 ${failed.length}` : ''}`;
      const bar = el('div', 'rn-footer-bar');
      const fill = el('i');
      fill.style.width = `${pct}%`;
      bar.appendChild(fill);
      info.append(title, sub, bar);
    } else {
      title.textContent = `共 ${items.length} 个文件`;
      if (skipped > 0) {
        // 明确告诉用户「有东西被筛掉了」—— 数字对不上是最容易被当成 bug 的。
        // 措辞要短：笔记页的面板只有 360px，长句会被挤成两行。
        sub.textContent = `已跳过 ${skipped} ${skippedLabel(vm.mediaFilter)}`;
      } else {
        sub.textContent = items.length
          ? `已完成 ${done.length}${failed.length ? ` · 失败 ${failed.length}` : ''}`
          : '暂无可下载内容';
      }
      info.append(title, sub);
    }
    this.footer.appendChild(info);

    const copyBtn = el('button', 'rn-btn');
    copyBtn.type = 'button';
    copyBtn.dataset.variant = 'text';
    copyBtn.innerHTML = `${icon('copy', 15)}复制直链`;
    copyBtn.disabled = items.length === 0;
    copyBtn.addEventListener('click', () => {
      const first = items[0];
      if (first) this.callbacks.onCopyLink(first.url);
    });
    this.footer.appendChild(copyBtn);

    const allBtn = el('button', 'rn-btn');
    allBtn.type = 'button';
    allBtn.dataset.variant = 'primary';
    const pending = items.filter((i) => {
      const s = vm.progress.get(i.id)?.state;
      return s === undefined || s === 'queued' || s === 'cancelled' || s === 'failed';
    });
    if (pending.length === 0 && items.length > 0) {
      // 全都下完了：别再显示一个「(3)」的按钮让人以为还有东西没下
      allBtn.innerHTML = `${icon('check', 15)}已全部下载`;
      allBtn.disabled = true;
    } else {
      allBtn.innerHTML = `${icon('download', 15)}全部下载 (${pending.length})`;
      allBtn.disabled = pending.length === 0;
    }
    allBtn.addEventListener('click', () => {
      this.callbacks.onDownloadItems(pending);
    });
    this.footer.appendChild(allBtn);
  }

  /* ---------------------------- 批量面板 ---------------------------- */

  lastBatchVm: BatchViewModel | null = null;
  lastNoteVm: NoteViewModel | null = null;

  renderBatch(vm: BatchViewModel): void {
    this.preserveScroll(() => this.renderBatchInner(vm));
  }

  private renderBatchInner(vm: BatchViewModel): void {
    this.lastBatchVm = vm;
    this.mode = 'batch';
    // 只有「就绪」状态才有工具条 —— 扫描中/被拦/出错时留着上一帧的页签，
    // 用户会以为还能筛点什么
    this.toolbar.hidden = vm.phase !== 'ready';
    this.footer.hidden = false;

    /* Header */
    this.header.innerHTML = '';
    const avatar = el('div', 'rn-avatar');
    if (vm.avatar) {
      const img = document.createElement('img');
      img.src = vm.avatar;
      img.alt = '';
      avatar.appendChild(img);
    } else {
      avatar.innerHTML = logoSvg(18);
    }
    this.header.appendChild(avatar);

    const text = el('div', 'rn-head-text');
    const title = el('div', 'rn-head-title');
    title.id = 'rn-panel-title';
    title.textContent = vm.nickname || '用户主页';
    const sub = el('div', 'rn-head-sub');
    // 存一份引用：解析几百条笔记时只改这两行文字，
    // 不重新画整张网格（整张网格重建 = 几百张缩略图重新解码）
    this.batchHeadSub = sub;
    this.batchHeadTitle = title;
    this.updateBatchHeader(vm);
    text.append(title, sub);
    this.header.appendChild(text);
    this.header.append(this.buildHeadActions());

    /* Body */
    this.body.innerHTML = '';

    if (vm.phase === 'scanning') {
      const wrap = el('div');
      const scan = el('div', 'rn-scan');
      scan.innerHTML = `<div class="rn-scan-spin">${icon('spinner', 26)}</div>
        <div class="rn-scan-title">正在扫描这个账号的公开笔记…</div>
        <div class="rn-scan-sub">已发现 ${vm.scanInfo?.found ?? 0} 条，第 ${vm.scanInfo?.rounds ?? 0} 轮加载</div>`;
      wrap.appendChild(scan);
      const bar = el('div', 'rn-indeterminate');
      bar.innerHTML = '<i></i>';
      wrap.appendChild(bar);
      this.body.appendChild(wrap);

      const skel = el('div', 'rn-skeleton');
      for (let i = 0; i < 9; i += 1) skel.appendChild(el('div', 'rn-skel'));
      this.body.appendChild(skel);
      this.renderBatchFooter(vm);
      return;
    }

    if (vm.phase === 'blocked') {
      this.body.appendChild(
        this.buildEmptyState({
          title: '小红书要求登录后才能查看更多内容',
          body:
            vm.error ??
            '登录后可以扫描完整笔记列表，并下载原始画质。',
          actions: [
            { label: '登录小红书', variant: 'primary', onClick: () => this.callbacks.onLogin() },
            { label: '重新扫描', onClick: () => this.callbacks.onRescan() },
          ],
        }),
      );
      this.renderBatchFooter(vm);
      return;
    }

    if (vm.phase === 'error') {
      this.body.appendChild(
        this.buildEmptyState({
          title: '扫描失败',
          body: vm.error || '网络异常，请稍后再试。',
          actions: [
            { label: '重新扫描', variant: 'primary', onClick: () => this.callbacks.onRescan() },
          ],
        }),
      );
      this.renderBatchFooter(vm);
      return;
    }

    if (vm.cards.length === 0) {
      this.body.appendChild(
        this.buildEmptyState({
          title: '没有找到可下载的笔记',
          body: '这个账号的笔记可能全部设为私密，或者需要登录后才能查看。',
          actions: [
            { label: '登录小红书后重试', variant: 'primary', onClick: () => this.callbacks.onLogin() },
            { label: '重新扫描', onClick: () => this.callbacks.onRescan() },
          ],
        }),
      );
      this.renderBatchFooter(vm);
      return;
    }

    this.renderBatchToolbar(vm);

    const visible = vm.cards.filter((c) => this.inNoteFilter(c, vm.noteFilter));

    const grid = el('div', 'rn-grid');
    if (visible.length <= 2) grid.dataset.cols = '2';
    this.cardNodes.clear();
    this.itemToCard.clear();
    for (const card of visible) {
      grid.appendChild(this.buildCard(card, vm));
      for (const itemId of card.itemIds) this.itemToCard.set(itemId, card.noteId);
    }
    this.body.appendChild(grid);

    this.renderBatchFooter(vm);
  }

  private renderBatchToolbar(vm: BatchViewModel): void {
    this.toolbar.innerHTML = '';

    /* 第一行：按笔记类型筛选（决定看哪些卡片）+ 勾选操作 */
    const row = el('div', 'rn-toolbar-row');

    const noteLabel = el('span', 'rn-filter-label');
    noteLabel.textContent = '笔记类型';
    row.appendChild(noteLabel);

    const tabs = el('div', 'rn-tabs');
    const videoCount = vm.cards.filter((c) => c.type === 'video').length;
    const imageCount = vm.cards.filter((c) => c.type === 'image').length;
    const defs: Array<[typeof vm.noteFilter, string, number]> = [
      ['all', '全部', vm.cards.length],
      ['video', '视频', videoCount],
      ['image', '图集', imageCount],
    ];
    for (const [key, label, count] of defs) {
      const tab = el('button', 'rn-tab');
      tab.type = 'button';
      tab.setAttribute('role', 'tab');
      tab.setAttribute('aria-selected', String(vm.noteFilter === key));
      tab.innerHTML = `${label}<small>${count}</small>`;
      tab.addEventListener('click', () => {
        if (!this.lastBatchVm) return;
        this.lastBatchVm.noteFilter = key;
        this.renderBatch(this.lastBatchVm);
      });
      tabs.appendChild(tab);
    }
    row.appendChild(tabs);

    const right = el('div', 'rn-toolbar-right');
    const selectAll = el('button', 'rn-btn');
    selectAll.type = 'button';
    selectAll.dataset.variant = 'sm';
    const visibleSelected = vm.cards.filter(
      (c) => this.inNoteFilter(c, vm.noteFilter) && vm.selected.has(c.noteId),
    ).length;
    const visibleTotal = vm.cards.filter((c) => this.inNoteFilter(c, vm.noteFilter)).length;
    selectAll.innerHTML = visibleSelected > 0 && visibleSelected === visibleTotal
      ? `${icon('selectAll', 14)}取消全选`
      : `${icon('selectAll', 14)}全选`;
    selectAll.setAttribute(
      'aria-label',
      visibleSelected > 0 && visibleSelected === visibleTotal ? '取消全选当前列表' : '全选当前列表',
    );
    selectAll.addEventListener('click', () => {
      if (!this.lastBatchVm) return;
      const target = this.lastBatchVm;
      const allSelected = visibleSelected > 0 && visibleSelected === visibleTotal;
      for (const card of target.cards) {
        if (!this.inNoteFilter(card, target.noteFilter)) continue;
        if (allSelected) target.selected.delete(card.noteId);
        else target.selected.add(card.noteId);
      }
      this.renderBatch(target);
    });
    right.appendChild(selectAll);

    const invert = el('button', 'rn-btn');
    invert.type = 'button';
    invert.dataset.variant = 'sm';
    invert.innerHTML = icon('invert', 14);
    invert.setAttribute('aria-label', '反选当前列表');
    invert.addEventListener('click', () => {
      if (!this.lastBatchVm) return;
      const target = this.lastBatchVm;
      for (const card of target.cards) {
        if (!this.inNoteFilter(card, target.noteFilter)) continue;
        if (target.selected.has(card.noteId)) target.selected.delete(card.noteId);
        else target.selected.add(card.noteId);
      }
      this.renderBatch(target);
    });
    right.appendChild(invert);
    row.appendChild(right);
    this.toolbar.appendChild(row);

    /* 第二行：按文件类型筛选（决定下载哪些文件，不影响卡片列表） */
    const filterRow = el('div', 'rn-toolbar-row');
    filterRow.appendChild(this.buildMediaFilter(vm.mediaFilter));
    this.toolbar.appendChild(filterRow);

    /* 第三行：保存结构（决定文件落在哪种目录里） */
    const structureRow = el('div', 'rn-toolbar-row');
    structureRow.appendChild(this.buildSaveStructure(vm.saveStructure));
    this.toolbar.appendChild(structureRow);
  }

  /** 卡片是否落在当前的笔记类型筛选里 */
  private inNoteFilter(card: BatchCard, filter: NoteFilter): boolean {
    if (filter === 'all') return true;
    return filter === 'video' ? card.type === 'video' : card.type === 'image';
  }

  private buildCard(card: BatchCard, vm: BatchViewModel): HTMLElement {
    const node = el('div', 'rn-card');
    node.tabIndex = 0;
    node.setAttribute('role', 'checkbox');
    const selected = vm.selected.has(card.noteId);
    node.dataset.selected = String(selected);
    node.setAttribute('aria-checked', String(selected));
    node.setAttribute(
      'aria-label',
      `${card.title || '未命名笔记'}，${card.type === 'video' ? '视频' : '图集'}${selected ? '，已选中' : ''}`,
    );

    const imgWrap = el('div', 'rn-card-img');
    if (card.cover) {
      const img = document.createElement('img');
      img.src = card.cover;
      img.alt = '';
      img.loading = 'lazy';
      imgWrap.appendChild(img);
    } else {
      const empty = el('div', 'rn-card-empty');
      empty.innerHTML = icon(card.type === 'video' ? 'video' : 'gallery', 20);
      imgWrap.appendChild(empty);
    }

    const chip = el('div', 'rn-chip');
    if (card.type === 'video') {
      chip.innerHTML = `${icon('play', 11)}视频`;
    } else {
      chip.innerHTML = `${icon('gallery', 11)}${card.mediaCount ? `${card.mediaCount} 张` : '图集'}`;
    }
    imgWrap.appendChild(chip);
    node.appendChild(imgWrap);

    const check = el('div', 'rn-check');
    check.setAttribute('aria-hidden', 'true');
    check.innerHTML = icon('check', 12);
    node.appendChild(check);

    const title = el('div', 'rn-card-title');
    title.textContent = card.title || '未命名笔记';
    node.appendChild(title);

    const meta = el('div', 'rn-card-meta');
    node.appendChild(meta);

    const refs: BatchCardRefs = { node, card, imgWrap, meta, state: '' };
    this.cardNodes.set(card.noteId, refs);
    this.paintCard(refs, vm);

    const toggle = () => {
      if (!this.lastBatchVm) return;
      if (this.lastBatchVm.selected.has(card.noteId)) this.lastBatchVm.selected.delete(card.noteId);
      else this.lastBatchVm.selected.add(card.noteId);
      this.renderBatch(this.lastBatchVm);
    };
    node.addEventListener('click', toggle);
    node.addEventListener('keydown', (event) => {
      if (event.key === ' ' || event.key === 'Enter') {
        event.preventDefault();
        toggle();
      }
    });

    return node;
  }

  /**
   * 把下载状态画到卡片上（整块渲染与增量更新共用这一份逻辑）。
   *
   * 缩略图 img 绝不碰 —— 它一被重建就得重新解码，
   * 几十张卡片一起重来，主线程会明显卡一下。
   */
  private paintCard(refs: BatchCardRefs, vm: BatchViewModel): void {
    const card = refs.card;
    const p = this.progressForCard(card, vm);
    const state = p?.state ?? 'idle';

    const status = cardStatusHtml(p);
    if (status) {
      refs.meta.innerHTML = status;
    } else if (card.resolving) {
      // 「解析中」和「解析失败」都要排在「赞」前面 ——
      // 赞数只是个装饰，把失败盖住的话用户根本不知道这条没解析出来
      refs.meta.innerHTML = `<span class="rn-resolving">${icon('spinner', 11)}解析中…</span>`;
    } else if (card.failed) {
      refs.meta.innerHTML = '<span class="rn-err">解析失败</span>';
    } else if (card.resolved && card.mediaCount === 0) {
      // 解析出来了，但一个资源都没拿到（只有文字，或者媒体一直没补上）。
      // 这跟「解析失败」是两回事 —— 不能混为一谈，也不能装作没事。
      refs.meta.textContent = '未取到资源';
    } else if (card.likedCount) {
      refs.meta.textContent = `${card.likedCount} 赞`;
    } else {
      refs.meta.textContent = card.resolved ? '' : '待解析';
    }

    // 进度环：只改 dashoffset，SVG 不重建（CSS 里本来就有过渡动画）
    const overlay = refs.imgWrap.querySelector('.rn-card-overlay');
    if (state === 'downloading' && p) {
      const pct = percent(p) ?? 0;
      if (overlay) {
        const arc = overlay.querySelector('.bar');
        if (arc) arc.setAttribute('stroke-dashoffset', ringOffset(pct).toFixed(2));
        const text = overlay.querySelector('.rn-ring-text');
        if (text) text.textContent = `${pct}%`;
      } else {
        refs.imgWrap.appendChild(this.buildRingOverlay(pct));
      }
    } else if (overlay) {
      overlay.remove();
    }

    // 完成角标
    const done = refs.node.querySelector('.rn-card-done');
    if (state === 'completed') {
      if (!done) refs.node.appendChild(this.buildCardDone());
    } else if (done) {
      done.remove();
    }
  }

  /** 卡片上的进度环 */
  private buildRingOverlay(pct: number): HTMLElement {
    const overlay = el('div', 'rn-card-overlay');
    overlay.innerHTML = ringSvg(pct);
    const text = el('div', 'rn-ring-text');
    text.textContent = `${pct}%`;
    overlay.appendChild(text);
    return overlay;
  }

  /** 卡片右上角的完成角标 */
  private buildCardDone(): HTMLElement {
    const done = el('div', 'rn-check rn-card-done');
    done.style.cssText = 'right:6px;top:6px;background:var(--success);border-color:var(--success);color:#fff';
    done.innerHTML = icon('check', 12);
    return done;
  }

  private progressForCard(card: BatchCard, vm: BatchViewModel): DownloadProgress | undefined {
    for (const itemId of card.itemIds) {
      const p = vm.progress.get(itemId);
      if (!p) continue;
      if (
        p.state === 'downloading' ||
        p.state === 'failed' ||
        p.state === 'retrying' ||
        // 等用户选保存目录：也得让人看见，不然像卡住了
        p.state === 'waiting'
      ) {
        return p;
      }
      if (p.state === 'completed' && card.itemIds.every((id) => vm.progress.get(id)?.state === 'completed')) {
        return p;
      }
    }
    return undefined;
  }

  /**
   * 只更新进度，不重建面板。
   *
   * 下载进度每秒变好几次。整块重画的话，几十张卡片的 <img> 会被反复
   * 销毁重建 —— 图片要重新解码，主线程直接卡住，滚动和点击都跟着顿。
   * 这里只改变化的那几行 / 那几张卡，缩略图一根手指都不动。
   */
  patchProgress(changed: DownloadProgress[]): void {
    if (changed.length === 0) return;

    if (this.mode === 'note') {
      const vm = this.lastNoteVm;
      if (!vm) return;
      for (const p of changed) {
        const refs = this.noteRows.get(p.itemId);
        if (!refs) continue;
        this.paintRow(refs, p);
      }
      this.renderNoteFooter(vm);
      return;
    }

    const vm = this.lastBatchVm;
    if (!vm) return;
    const touched = new Set<string>();
    for (const p of changed) {
      const noteId = this.itemToCard.get(p.itemId);
      if (noteId) touched.add(noteId);
    }
    for (const noteId of touched) {
      const refs = this.cardNodes.get(noteId);
      if (!refs) continue;
      this.paintCard(refs, vm);
    }
    this.renderBatchFooter(vm);
  }

  /**
   * 只改主页头部的那行说明文字。
   *
   * 解析进度每解析一条就变一次 —— 走这条路只是改两个 textContent，
   * 不碰网格里的任何一张卡片。
   */
  private updateBatchHeader(vm: BatchViewModel): void {
    const sub = this.batchHeadSub;
    if (!sub) return;
    const videoCount = vm.cards.filter((c) => c.type === 'video').length;
    const imageCount = vm.cards.filter((c) => c.type === 'image').length;
    if (vm.phase === 'scanning') {
      sub.textContent = `正在扫描这个账号的公开笔记…（已发现 ${vm.scanInfo?.found ?? 0} 条）`;
    } else if (vm.phase === 'blocked') {
      sub.textContent = '需要登录才能扫描这个账号的完整笔记';
    } else if (vm.cards.length === 0) {
      sub.textContent = '没有识别到笔记';
    } else if (vm.resolving && vm.resolveInfo) {
      const r = vm.resolveInfo;
      sub.textContent = `正在解析 ${r.done}/${r.total} 条笔记${r.failed ? `（${r.failed} 条失败）` : ''}`;
    } else {
      // 解析走的是哪条路，写出来 —— 两条路给的东西可能不一样，
      // 用户一眼就能看出这批内容是不是按页面看到的样子下的。
      const paths = vm.parsePaths ?? (vm.parsePath ? [vm.parsePath] : []);
      const pathLabel = describeParsePaths(paths, vm.parseTrusted);
      sub.textContent = `已扫描 ${vm.cards.length} 条笔记（视频 ${videoCount} / 图集 ${imageCount}）${pathLabel}`;
    }
  }

  /**
   * 解析进度更新：只补画刚变的那几张卡片。
   *
   * 以前每解析完一条笔记就把整张网格重画一遍（body.innerHTML = '' 再重建），
   * 几百条笔记时 = 几百次 × 几百张卡片，缩略图每次都要重新解码 ——
   * 主线程被渲染占满，解析本身也跟着卡住。
   */
  patchBatchResolve(vm: BatchViewModel, noteIds: string[]): void {
    for (const noteId of noteIds) {
      const refs = this.cardNodes.get(noteId);
      if (!refs) continue;
      this.paintCard(refs, vm);
    }
    this.updateBatchHeader(vm);
    this.renderBatchFooter(vm);
  }

  private renderBatchFooter(vm: BatchViewModel): void {
    this.footer.innerHTML = '';
    const info = el('div', 'rn-footer-info');
    const title = el('div', 'rn-footer-title');
    const sub = el('div', 'rn-footer-sub');

    const selectedCards = vm.cards.filter((c) => vm.selected.has(c.noteId));
    const allItems = [...vm.progress.values()];
    const doneCount = allItems.filter((p) => p.state === 'completed').length;
    const failCount = allItems.filter((p) => p.state === 'failed').length;
    const runningCount = allItems.filter(
      (p) => p.state === 'downloading' || p.state === 'retrying',
    ).length;
    const queueCount = allItems.filter((p) => p.state === 'queued').length;

    if (vm.phase === 'scanning') {
      title.textContent = '扫描中';
      sub.textContent = `已发现 ${vm.scanInfo?.found ?? 0} 条`;
      info.append(title, sub);
      this.footer.appendChild(info);
      const stop = el('button', 'rn-btn');
      stop.type = 'button';
      stop.innerHTML = '停止扫描';
      stop.addEventListener('click', () => this.callbacks.onStopScan());
      this.footer.appendChild(stop);
      return;
    }

    if (vm.phase === 'completed') {
      title.textContent = failCount > 0 ? `完成 ${doneCount} 个，${failCount} 个失败` : '全部下载完成';
      sub.textContent = `成功 ${doneCount}${failCount ? ` · 失败 ${failCount}` : ''} · 共 ${allItems.length} 个文件`;
      info.append(title, sub);
      const bar = el('div', 'rn-footer-bar');
      const fill = el('i');
      const pct = allItems.length ? Math.round((doneCount / allItems.length) * 100) : 100;
      fill.style.width = `${pct}%`;
      bar.appendChild(fill);
      info.appendChild(bar);
      this.footer.appendChild(info);

      const openList = el('button', 'rn-btn');
      openList.type = 'button';
      openList.innerHTML = `${icon('folder', 15)}下载列表`;
      openList.setAttribute('aria-label', '打开浏览器下载列表');
      openList.addEventListener('click', () => this.callbacks.onOpenDownloads());
      this.footer.appendChild(openList);

      if (failCount > 0) {
        const retry = el('button', 'rn-btn');
        retry.type = 'button';
        retry.dataset.variant = 'primary';
        retry.innerHTML = `${icon('retry', 15)}重试失败项`;
        retry.addEventListener('click', () => {
          for (const p of allItems.filter((x) => x.state === 'failed')) {
            this.callbacks.onRetry(p.itemId);
          }
        });
        this.footer.appendChild(retry);
      }
      return;
    }

    if (vm.resolving && vm.resolveInfo) {
      const r = vm.resolveInfo;
      title.textContent = `正在解析 ${r.done}/${r.total} 条笔记`;
      sub.textContent = r.failed
        ? `已有 ${r.failed} 条解析失败，会在下载完成后告诉你`
        : '正在读取每条笔记的原始资源';
    } else if (selectedCards.length > 0) {
      title.textContent = `已选 ${selectedCards.length} 项`;
      const videos = selectedCards.filter((c) => c.type === 'video').length;
      const images = selectedCards.filter((c) => c.type === 'image').length;
      sub.textContent = `共 ${videos} 个视频、${images} 个图集`;
      if (vm.mediaFilter !== 'all') {
        // 文件数要等解析完才知道，但「只下什么」必须现在就说清楚
        sub.textContent += ` · 只下载${mediaFilterLabel(vm.mediaFilter)}文件`;
      }
      sub.textContent += ` · ${saveStructureName(vm.saveStructure)}`;
    } else {
      title.textContent = '请选择要下载的内容';
      sub.textContent = `共 ${vm.cards.length} 条笔记`;
    }
    info.append(title, sub);

    if (runningCount > 0 || queueCount > 0) {
      const bar = el('div', 'rn-footer-bar');
      const fill = el('i');
      const total = allItems.length || 1;
      fill.style.width = `${Math.round((doneCount / total) * 100)}%`;
      bar.appendChild(fill);
      info.appendChild(bar);
    }
    this.footer.appendChild(info);

    if (selectedCards.length > 0) {
      const clear = el('button', 'rn-btn');
      clear.type = 'button';
      clear.dataset.variant = 'text';
      clear.textContent = '清空选择';
      clear.addEventListener('click', () => {
        if (!this.lastBatchVm) return;
        this.lastBatchVm.selected.clear();
        this.renderBatch(this.lastBatchVm);
      });
      this.footer.appendChild(clear);
    }

    const start = el('button', 'rn-btn');
    start.type = 'button';
    start.dataset.variant = 'primary';
    start.innerHTML = vm.resolving
      ? `${icon('spinner', 15)}解析中…`
      : `${icon('download', 15)}开始下载${selectedCards.length ? ` (${selectedCards.length})` : ''}`;
    start.disabled = selectedCards.length === 0 || vm.resolving;
    start.addEventListener('click', () => {
      this.callbacks.onResolveSelection([...vm.selected]);
    });
    this.footer.appendChild(start);
  }

  /* ---------------------------- 通用块 ---------------------------- */

  private buildHeadActions(): HTMLElement {
    const actions = el('div', 'rn-head-actions');
    const settings = el('button', 'rn-icon-btn');
    settings.type = 'button';
    settings.setAttribute('aria-label', '打开设置');
    settings.innerHTML = icon('gear', 16);
    settings.addEventListener('click', () => this.callbacks.onOpenOptions());
    actions.appendChild(settings);

    const close = el('button', 'rn-icon-btn');
    close.type = 'button';
    close.setAttribute('aria-label', '关闭下载面板');
    close.innerHTML = icon('close', 16);
    close.addEventListener('click', () => {
      this.close();
      this.fab.focus();
    });
    actions.appendChild(close);
    return actions;
  }

  private buildScanState(title: string, sub: string): HTMLElement {
    const wrap = el('div', 'rn-scan');
    wrap.innerHTML = `<div class="rn-scan-spin">${icon('spinner', 26)}</div>
      <div class="rn-scan-title">${title}</div>
      <div class="rn-scan-sub">${sub}</div>`;
    return wrap;
  }

  private buildEmptyState(options: {
    title: string;
    body: string;
    actions?: Array<{ label: string; variant?: 'primary' | 'text'; onClick: () => void }>;
  }): HTMLElement {
    const wrap = el('div', 'rn-state');
    const iconWrap = el('div', 'rn-state-icon');
    iconWrap.innerHTML = icon('info', 64);
    const title = el('div', 'rn-state-title');
    title.textContent = options.title;
    const body = el('div', 'rn-state-sub');
    body.textContent = options.body;
    wrap.append(iconWrap, title, body);
    if (options.actions?.length) {
      const actions = el('div', 'rn-state-actions');
      for (const action of options.actions) {
        const btn = el('button', 'rn-btn');
        btn.type = 'button';
        if (action.variant) btn.dataset.variant = action.variant;
        btn.textContent = action.label;
        btn.addEventListener('click', action.onClick);
        actions.appendChild(btn);
      }
      wrap.appendChild(actions);
    }
    return wrap;
  }

  /* ---------------------------- FAB 徽标 ---------------------------- */

  setFabBadge(count: number): void {
    this.fabBadge.textContent = count > 99 ? '99+' : String(count);
    this.fab.dataset.badge = count > 0 ? '1' : '0';
    this.fab.setAttribute(
      'aria-label',
      count > 0 ? `下载当前页面的内容，共 ${count} 个资源` : '下载当前页面的内容',
    );
  }

  setFabBackgroundProgress(pct: number | null): void {
    if (pct === null) {
      this.fabRing.setAttribute('hidden', '');
      this.fab.dataset.mode = '';
      return;
    }
    this.fabRing.removeAttribute('hidden');
    this.fab.dataset.mode = 'bg';
    const circle = this.fabRing.querySelector('.bar') as SVGCircleElement | null;
    if (!circle) return;
    const r = 22;
    const c = 2 * Math.PI * r;
    circle.setAttribute('stroke-dasharray', c.toFixed(2));
    circle.setAttribute('stroke-dashoffset', (c * (1 - pct / 100)).toFixed(2));
  }
}

function describeNote(note: NoteInfo, items: MediaItem[]): string {
  const videos = items.filter((i) => i.kind === 'video').length;
  const images = items.filter((i) => i.kind === 'image').length;
  const bits: string[] = [];
  if (videos) bits.push(`${videos} 个视频`);
  if (images) bits.push(`${images} 张图片`);
  if (!bits.length) return note.author || '无可下载内容';
  const author = note.author ? `${sanitizeSegment(note.author, 12)} · ` : '';
  return `${author}${bits.join(' · ')}`;
}

/** 被筛掉的那一类怎么称呼（「1 张图片」/「1 个视频」） */
function skippedLabel(filter: MediaFilter): string {
  return filter === 'video' ? '张图片' : '个视频';
}
