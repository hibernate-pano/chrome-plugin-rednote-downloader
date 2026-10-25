import { PageBridge } from './bridge';
import { Detector, classifyPage, type PageKind } from './detect/detector';
import { buildRelativePath, fileNameForItem } from './detect/media';
import type { RawNoteRef } from './detect/raw';
import { MSG } from '../shared/messages';
import type {
  DownloadProgress,
  DownloadTaskItem,
  MediaFilter,
  MediaItem,
  NoteInfo,
  SaveStructure,
  Settings,
} from '../shared/types';
import { DEFAULT_SETTINGS } from '../shared/types';
import {
  filterByMediaFilter,
  matchesMediaFilter,
  mediaFilterLabel,
  saveStructureName,
  SAVE_STRUCTURE_HINTS,
  shortId,
  sleep,
} from '../shared/utils';
import { loadSettings, updateSettings } from './settings';
import { Panel, type BatchCard, type BatchViewModel, type NoteViewModel } from './ui/panel';
import { ToastManager } from './ui/toast';
import { icon } from './ui/icons';

const NOTE_KEY = 'note';
const BATCH_KEY = 'batch';

class App {
  private bridge = new PageBridge();
  private detector: Detector;
  private panel!: Panel;
  private toast = new ToastManager();
  private settings!: Settings;

  private pageKind: PageKind = 'unknown';
  private currentPath = '';
  private note: NoteInfo | null = null;
  private noteDetecting = false;
  private noteError: string | undefined;
  private detectToken = 0;

  private batch: BatchViewModel = {
    phase: 'scanning',
    cards: [],
    noteFilter: 'all',
    mediaFilter: 'all',
    saveStructure: 'perNote',
    selected: new Set(),
    progress: new Map(),
    resolving: false,
  };
  private batchTaskId: string | undefined;
  private noteTaskId: string | undefined;
  private scanned = false;
  /** 本次页面会话是否已经发起过主页扫描（避免重复触发） */
  private batchStarted = false;
  /** 文件类型筛选：决定「下载哪些文件」 */
  private mediaFilter: MediaFilter = 'all';
  /** 保存结构：每篇笔记一个独立文件夹，还是全部放进主文件夹 */
  private saveStructure: SaveStructure = 'perNote';

  constructor() {
    this.detector = new Detector({
      bridge: this.bridge,
      getSettings: () => this.settings,
    });
  }

  async init(): Promise<void> {
    // 先用默认设置把 UI 立起来，再异步拉真实设置 —— 否则 Service Worker 冷启动会拖慢首屏
    this.settings = { ...DEFAULT_SETTINGS };

    this.panel = new Panel(
      {
        onDownloadItems: (items) => void this.startDownload(items),
        onCopyLink: (url) => void this.copyLink(url),
        onScan: () => void this.startScan(),
        onStopScan: () => void this.stopScan(),
        onRescan: () => void this.rescan(),
        onRetry: (itemId) => void this.retry(itemId),
        onCancelTask: () => void this.cancelTask(),
        onOpenDownloads: () => void this.openDownloads(),
        onOpenOptions: () => void chrome.runtime.sendMessage({ type: MSG.OPEN_OPTIONS }),
        onLogin: () => this.openLogin(),
        onResolveSelection: (ids) => void this.resolveAndDownload(ids),
        onMediaFilterChange: (filter) => void this.setMediaFilter(filter),
        onSaveStructureChange: (structure) => void this.setSaveStructure(structure),
        onFabClick: () => this.onFabClick(),
      },
      this.settings,
    );
    this.panel.mount();
    this.toast.mount(this.panel.shadowRoot);

    // 设置就绪后同步到面板（主题 / 并发 / 命名 / 文件类型筛选 / 保存结构）
    void loadSettings().then((settings) => {
      this.applySettings(settings);
      this.panel.setTheme(settings.theme);
      if (this.pageKind === 'note') this.renderNote();
      else if (this.pageKind === 'profile') this.panel.renderBatch(this.batch);
    });

    this.bridge.onRoute((path) => void this.onRoute(path));
    // 站点数据就绪后再识别一次（首屏 document_start 时 __INITIAL_STATE__ 还不存在）
    this.bridge.onStateReady(() => {
      if (this.pageKind === 'note' && !this.note && !this.noteDetecting) {
        void this.detectNote();
      }
    });
    void this.onRoute(`${location.pathname}${location.search}`);

    // 设置页改了命名模板或保存结构，面板要立刻跟上 ——
    // 否则用户看到的是旧文件名，落盘的却是新文件名
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      const next = changes['rednote.settings']?.newValue as Partial<Settings> | undefined;
      if (!next) return;
      this.applySettings({ ...this.settings, ...next });
    });

    chrome.runtime.onMessage.addListener((message: any, _sender, sendResponse) => {
      if (message?.type === MSG.DOWNLOAD_PROGRESS) {
        this.onProgress(message.progress as DownloadProgress[]);
        return;
      }
      if (message?.type === 'GET_PAGE_INFO') {
        sendResponse({
          ok: true,
          info: {
            kind: this.pageKind,
            title: this.note?.title,
            author: this.note?.author,
            cover: this.note?.cover,
            items: this.note?.items.length,
            videos: this.note?.items.filter((i) => i.kind === 'video').length,
            images: this.note?.items.filter((i) => i.kind === 'image').length,
          },
        });
        return;
      }
      if (message?.type === 'OPEN_PANEL') {
        if (this.pageKind === 'profile' && !this.batchStarted) {
          void this.startScan();
        } else {
          this.panel.open();
          if (this.pageKind === 'note') this.renderNote();
          else this.panel.renderBatch(this.batch);
        }
      }
    });

    // 首次使用引导
    void this.maybeShowCoachMark();

    // 主页卡片 hover 快捷下载
    this.installHoverButton();
  }

  /* --------------------------- 路由 --------------------------- */

  private async onRoute(path: string): Promise<void> {
    // 站点初始化时会 replaceState 一次，路径没变就别重识别。
    // 否则面板会被清空重建 —— 用户正好在这几秒里点下载，
    // 按钮已经不在了，就是一次静默无响应（这是最难查的那种失败）。
    if (path === this.currentPath) return;
    this.currentPath = path;

    const kind = classifyPage(path);
    if (kind === this.pageKind && this.scanned) return;
    this.pageKind = kind;
    this.scanned = false;

    if (kind === 'note') {
      this.panel.setMode('note');
      await this.detectNote();
    } else if (kind === 'profile') {
      this.panel.setMode('batch');
      this.resetBatch();
      this.panel.setFabBadge(0);
      this.panel.renderBatch(this.batch);
    } else {
      this.panel.setFabBadge(0);
    }
  }

  /** 主按钮：主页上一点就直接开始扫描，其它页面只是开关面板 */
  private onFabClick(): void {
    if (this.pageKind === 'profile' && !this.batchStarted) {
      this.panel.open();
      void this.startScan();
      return;
    }
    this.panel.toggle();
  }

  private async detectNote(): Promise<void> {
    const token = ++this.detectToken;
    this.noteDetecting = true;
    this.noteError = undefined;

    const path = `${location.pathname}${location.search}`;
    const pathNoteId = path.match(/\/(?:explore|discovery\/item)\/([A-Za-z0-9_-]+)/i)?.[1] ?? '';
    // 换成了另一篇笔记才清空旧结果；同一篇重新识别时保留内容，
    // 免得用户正要点的下载按钮凭空消失
    if (!this.note || (pathNoteId && this.note.noteId !== pathNoteId)) {
      this.note = null;
    }
    this.renderNote();

    // 扩展在 document_start 就注入了，此时站点还没写入 __INITIAL_STATE__、DOM 也是空的。
    // 所以要一直重试：优先等页面数据（直链最稳），实在拿不到再用 DOM 兜底。
    const deadline = Date.now() + 12000;
    let attempt = 0;
    let domInfo: NoteInfo | null = null;

    try {
      for (;;) {
        const note = await this.detector.detectNoteFromState(path);
        if (token !== this.detectToken) return; // 路由已经变了，交给新的检测流程
        if (note) {
          this.note = note;
          this.panel.setFabBadge(note.items.length);
          return;
        }
        if (!domInfo) domInfo = this.detector.detectNoteFromDom(path);
        attempt += 1;
        if (Date.now() >= deadline) break;
        this.renderNote(); // 保持骨架屏，告诉用户「还在识别」
        await sleep(Math.min(1000, 200 * attempt));
      }

      if (domInfo) {
        this.note = domInfo;
        this.panel.setFabBadge(domInfo.items.length);
        return;
      }

      // 之前已经识别出内容的话，别用错误覆盖它 ——
      // 用户手上还指着那个下载按钮，不该突然变成一句报错
      if (!this.note) {
        this.noteError = '这条笔记可能只有文字，或者需要登录后才能查看原始图片与视频。';
      }
      this.panel.setFabBadge(this.note ? this.note.items.length : 0);
    } catch {
      if (!this.note) {
        this.noteError = '读取页面数据时出了点问题，刷新后可以重试。';
      }
    } finally {
      if (token === this.detectToken) {
        this.noteDetecting = false;
        this.renderNote();
      }
    }
  }

  /** 把一份新设置同步到各处（面板、筛选、保存结构） */
  private applySettings(settings: Settings): void {
    this.settings = settings;
    this.mediaFilter = settings.downloadFilter;
    this.batch.mediaFilter = settings.downloadFilter;
    this.saveStructure = settings.saveStructure;
    this.batch.saveStructure = settings.saveStructure;
    this.panel.setSettings(settings);
  }

  private renderNote(): void {
    const vm: NoteViewModel = {
      note: this.note,
      detecting: this.noteDetecting,
      error: this.noteError,
      progress: this.progressMap,
      mediaFilter: this.mediaFilter,
      saveStructure: this.saveStructure,
    };
    this.panel.renderNote(vm);
  }

  /**
   * 切换文件类型筛选（只下载视频 / 只下载图片）。
   *
   * 存进设置里，这样换页面、关掉面板再打开都还认这个偏好 ——
   * 「我只想存视频」是个长期意图，不是一次性的操作。
   */
  private async setMediaFilter(filter: MediaFilter): Promise<void> {
    if (this.mediaFilter === filter) return;
    this.applySettings({ ...this.settings, downloadFilter: filter });

    // 先重绘，让筛选立刻生效；存设置失败也不影响本次使用
    if (this.pageKind === 'note') this.renderNote();
    else this.panel.renderBatch(this.batch);

    try {
      this.settings = await updateSettings({ downloadFilter: filter });
    } catch {
      /* 存不住就只在本次会话生效，不打扰用户 */
    }
  }

  /**
   * 切换保存结构（每篇笔记一个独立文件夹 / 按作者分文件夹 / 全部平铺）。
   *
   * 这是「文件放哪」而不是「下什么」，所以只改目录，不动筛选。
   * 存进设置里 —— 换个账号、换天再下，用户不想重新选一遍。
   */
  private async setSaveStructure(structure: SaveStructure): Promise<void> {
    if (this.saveStructure === structure) return;
    this.applySettings({ ...this.settings, saveStructure: structure });

    if (this.pageKind === 'note') this.renderNote();
    else this.panel.renderBatch(this.batch);

    this.toast.info(`已改为${saveStructureName(structure)}`, SAVE_STRUCTURE_HINTS[structure]);

    try {
      this.settings = await updateSettings({ saveStructure: structure });
    } catch {
      /* 存不住就只在本次会话生效，不打扰用户 */
    }
  }

  /* --------------------------- 主页批量 --------------------------- */

  private resetBatch(): void {
    this.batch = {
      phase: 'scanning',
      cards: [],
      noteFilter: 'all',
      mediaFilter: this.mediaFilter,
      saveStructure: this.saveStructure,
      selected: new Set(),
      progress: new Map(),
      resolving: false,
    };
    this.batchTaskId = undefined;
    this.batchStarted = false;
  }

  private async startScan(): Promise<void> {
    this.resetBatch();
    this.batchStarted = true;
    this.scanned = true;
    this.panel.setMode('batch');
    this.panel.open();
    this.panel.renderBatch(this.batch);

    try {
      const result = await this.detector.scanProfile((info) => {
        this.batch.scanInfo = info;
        this.panel.renderBatch(this.batch);
      });

      if (result.blocked) {
        this.batch.phase = 'blocked';
        this.batch.error = result.blockedReason;
        this.panel.renderBatch(this.batch);
        return;
      }

      this.batch.phase = 'ready';
      this.batch.scanInfo = { found: result.refs.length, rounds: result.rounds };
      this.batch.cards = result.refs.map((ref) => {
        if (ref.xsecToken) this.xsecTokens.set(ref.noteId, ref.xsecToken);
        return this.toCard(ref);
      });
      this.panel.setFabBadge(this.batch.cards.length);
      this.panel.renderBatch(this.batch);
    } catch (err) {
      this.batch.phase = 'error';
      this.batch.error = err instanceof Error ? err.message : '网络异常，请稍后再试。';
      this.panel.renderBatch(this.batch);
    }
  }

  private toCard(ref: RawNoteRef): BatchCard {
    return {
      noteId: ref.noteId,
      title: ref.title ?? '',
      type: ref.type === 'video' ? 'video' : 'image',
      cover: ref.cover,
      likedCount: ref.likedCount,
      resolved: false,
      itemIds: [],
    };
  }

  private async stopScan(): Promise<void> {
    this.batch.phase = 'ready';
    this.panel.renderBatch(this.batch);
    this.toast.info('已停止扫描', '已发现的内容仍然可以下载');
  }

  private async rescan(): Promise<void> {
    await this.startScan();
  }

  /** 解析选中笔记的媒体资源，然后开始下载 */
  private async resolveAndDownload(noteIds: string[]): Promise<void> {
    if (noteIds.length === 0) return;
    this.batch.resolving = true;
    const info = { done: 0, total: noteIds.length, failed: 0 };
    this.batch.resolveInfo = info;
    this.panel.renderBatch(this.batch);

    // 每条笔记都要开一次 iframe 加载真实笔记页（实测单条 ~370ms）。
    // 串行等 30 条要十几秒，期间界面毫无反馈 —— 所以并发 4 条，
    // 并且每条卡片实时显示「解析中 / 解析失败」。
    const CONCURRENCY = 4;
    const queue = [...noteIds];
    const resolved = new Map<string, BatchCard>();

    const worker = async (): Promise<void> => {
      for (;;) {
        const noteId = queue.shift();
        if (noteId === undefined) return;
        const card = this.batch.cards.find((c) => c.noteId === noteId);
        if (!card) continue;

        if (!card.resolved) {
          card.resolving = true;
          card.failed = false;
          this.scheduleBatchRender();

          const detail = await this.detector.resolveNoteDetail({
            noteId: card.noteId,
            xsecToken: this.xsecTokenFor(noteId),
            title: card.title,
            type: card.type === 'video' ? 'video' : 'normal',
            cover: card.cover,
            index: 0,
          });

          card.resolving = false;
          this.queueBatchPatch(card.noteId);
          if (detail) {
            card.resolved = true;
            card.mediaCount = detail.items.length;
            card.itemIds = detail.items.map((_item, idx) => `${noteId}#${idx}`);
            if (!card.title) card.title = detail.info.title;
            if (!card.cover) card.cover = detail.info.cover;
            this.registerItems(card, detail.items);
          } else {
            // 失败必须留在界面上，不能静默跳过
            card.failed = true;
            info.failed += 1;
          }
        }
        resolved.set(noteId, card);

        info.done += 1;
        // 只补画刚变的那张卡片 —— 整张网格重画几百次会把主线程占满
        this.queueBatchPatch(noteId);
      }
    };

    await Promise.all(
      Array.from({ length: Math.min(CONCURRENCY, noteIds.length) }, () => worker()),
    );

    this.batch.resolving = false;

    // 告诉界面这批内容是用哪条路解析出来的 ——
    // 几条路给的东西可能不一样（清晰度、地址时效），
    // 显示出来用户才能一眼看出这批是不是按页面看到的样子下的。
    try {
      const path = await this.bridge.call<{
        path?: 'iframe' | 'fetch' | 'api';
        paths?: Array<'iframe' | 'fetch' | 'api'>;
        fastPathTrusted?: boolean;
      }>('api.parsePath');
      if (path?.path) this.batch.parsePath = path.path;
      if (path?.paths) this.batch.parsePaths = path.paths;
      if (path?.fastPathTrusted !== undefined) this.batch.parseTrusted = path.fastPathTrusted;
    } catch {
      /* ignore */
    }

    // 按用户勾选的顺序组装下载任务
    const taskItems: DownloadTaskItem[] = [];
    let skippedByFilter = 0;
    for (const noteId of noteIds) {
      const card = resolved.get(noteId);
      if (!card) continue;
      for (const id of card.itemIds) {
        const item = this.itemCache.get(id);
        if (!item) continue;
        // 文件类型筛选：视频笔记的封面是图片项，「只下载视频」时会被跳过
        if (!matchesMediaFilter(item.kind, this.mediaFilter)) {
          skippedByFilter += 1;
          continue;
        }
        taskItems.push({
          itemId: id,
          url: item.url,
          filename: this.pathFor(item),
          kind: item.kind,
          size: item.size,
          noteId: card.noteId,
          noteTitle: card.title,
          author: item.author,
        });
      }
    }
    this.panel.renderBatch(this.batch);

    if (taskItems.length === 0) {
      if (skippedByFilter > 0) {
        this.toast.info(
          `当前只下载${mediaFilterLabel(this.mediaFilter)}`,
          `选中的 ${noteIds.length} 条笔记里没有符合条件的文件，可在面板顶部改回「全部」`,
        );
        return;
      }
      this.toast.error(
        '没有解析出可下载的资源',
        info.failed > 0 ? '这些笔记可能需要登录后才能查看原始内容。' : undefined,
        { label: '去登录', onClick: () => this.openLogin() },
      );
      return;
    }

    this.batchTaskId = shortId('t');
    this.panel.renderBatch(this.batch);
    const started = await chrome.runtime.sendMessage({
      type: MSG.START_DOWNLOADS,
      taskId: this.batchTaskId,
      items: taskItems,
    });

    if (started?.waiting) {
      // 自研下载需要用户先选保存目录，选目录的窗口已经弹出来了
      this.toast.info('第一次用要先选保存目录', '选好之后就会开始下载，以后的文件都存到那里');
    } else {
      this.toast.info(
        `已开始下载 ${taskItems.length} 个文件`,
        [
          skippedByFilter > 0 ? `按「只下载${mediaFilterLabel(this.mediaFilter)}」跳过了 ${skippedByFilter} 个` : undefined,
          info.failed > 0 ? `有 ${info.failed} 条笔记没能解析出资源` : undefined,
        ]
          .filter(Boolean)
          .join(' · ') || undefined,
      );
    }
  }

  private itemCache = new Map<string, MediaItem>();
  private xsecTokens = new Map<string, string>();

  /**
   * 批量解析期间网格会连续变化，但每次重建整张网格代价不小（图片会重新挂载）。
   * 所以节流到 150ms 一次，用户看起来仍然是实时更新。
   */
  /**
   * 解析进度：攒一批 noteId，合并成一次补画。
   *
   * 解析几百条笔记时，每条都会变一次卡片状态。
   * 整张网格重画（几百张卡片 + 几百张缩略图重新解码）会把主线程占满，
   * 解析本身都被拖慢；只补画变了的卡片就没有这个问题。
   */
  private batchPatchQueue = new Set<string>();
  private batchPatchTimer: number | undefined;

  private queueBatchPatch(noteId: string): void {
    this.batchPatchQueue.add(noteId);
    if (this.batchPatchTimer !== undefined) return;
    this.batchPatchTimer = window.setTimeout(() => {
      this.batchPatchTimer = undefined;
      const ids = [...this.batchPatchQueue];
      this.batchPatchQueue.clear();
      if (ids.length === 0) return;
      this.panel.patchBatchResolve(this.batch, ids);
    }, 200);
  }

  private batchRenderTimer: number | undefined;

  private scheduleBatchRender(): void {
    if (this.batchRenderTimer !== undefined) return;
    this.batchRenderTimer = window.setTimeout(() => {
      this.batchRenderTimer = undefined;
      this.panel.renderBatch(this.batch);
    }, 150);
  }

  private registerItems(card: BatchCard, items: MediaItem[]): void {
    items.forEach((item, idx) => {
      this.itemCache.set(`${card.noteId}#${idx}`, item);
    });
  }

  private xsecTokenFor(noteId: string): string | undefined {
    return this.xsecTokens.get(noteId);
  }

  private pathFor(item: MediaItem): string {
    return buildRelativePath(
      { settings: this.settings, rootFolder: this.settings.rootFolder },
      {
        author: item.author,
        title: item.noteTitle,
        filename: fileNameForItem(this.settings, item),
      },
    );
  }

  /* --------------------------- 下载 --------------------------- */

  private progressMap = new Map<string, DownloadProgress>();

  private async startDownload(items: MediaItem[]): Promise<void> {
    if (items.length === 0) return;
    // 文件类型筛选在这里兜底：所有入口（面板按钮、主页悬停按钮）都走这一条路
    const picked = filterByMediaFilter(items, this.mediaFilter);
    if (picked.length === 0) {
      this.toast.info(
        `当前只下载${mediaFilterLabel(this.mediaFilter)}`,
        '这条内容里没有符合条件的文件，可在面板顶部改回「全部」',
      );
      return;
    }
    const taskId = shortId('t');
    this.noteTaskId = taskId;
    const started = await chrome.runtime.sendMessage({
      type: MSG.START_DOWNLOADS,
      taskId,
      items: picked.map<DownloadTaskItem>((item) => ({
        itemId: item.id,
        url: item.url,
        filename: this.pathFor(item),
        kind: item.kind,
        size: item.size,
        noteId: item.noteId,
        noteTitle: item.noteTitle,
        author: item.author,
      })),
    });
    const skipped = items.length - picked.length;
    if (started?.waiting) {
      this.toast.info('第一次用要先选保存目录', '选好之后就会开始下载，以后的文件都存到那里');
      return;
    }
    this.toast.info(
      `已开始下载 ${picked.length} 个文件`,
      skipped > 0 ? `按「只下载${mediaFilterLabel(this.mediaFilter)}」跳过了 ${skipped} 个` : undefined,
    );
  }

  /** 「打开下载」：跳到 Chrome 的下载列表 */
  private async openDownloads(): Promise<void> {
    await chrome.runtime.sendMessage({ type: 'SHOW_DOWNLOADS' });
  }

  private async retry(itemId: string): Promise<void> {
    const taskId = this.batchTaskId ?? this.noteTaskId;
    if (!taskId) return;
    await chrome.runtime.sendMessage({ type: MSG.RETRY_TASK_ITEM, taskId, itemId });
  }

  private async cancelTask(): Promise<void> {
    const taskId = this.batchTaskId ?? this.noteTaskId;
    if (!taskId) return;
    await chrome.runtime.sendMessage({ type: MSG.CANCEL_TASK, taskId });
  }

  private onProgress(list: DownloadProgress[]): void {
    for (const progress of list) {
      this.progressMap.set(progress.itemId, progress);
      if (progress.taskId === this.batchTaskId) {
        this.batch.progress.set(progress.itemId, progress);
      }
    }

    const all = [...this.progressMap.values()];
    const completed = all.filter((p) => p.state === 'completed').length;
    const failed = all.filter((p) => p.state === 'failed').length;
    const running = all.filter(
      (p) =>
        p.state === 'downloading' ||
        p.state === 'retrying' ||
        p.state === 'queued' ||
        p.state === 'waiting',
    ).length;
    const settled = all.filter(
      (p) => p.state === 'completed' || p.state === 'failed' || p.state === 'cancelled',
    ).length;
    const total = all.length;
    const pct = total > 0 ? Math.round((settled / total) * 100) : 0;

    this.panel.setFabBackgroundProgress(running > 0 || settled < total ? pct : null);

    // 只补变化的那几行 / 那几张卡，不整块重画 ——
    // 整块重画会把几十张卡片的缩略图反复重建，主线程会明显卡顿
    this.panel.patchProgress(list);

    if (running === 0 && total > 0 && settled === total) {
      this.panel.setFabBackgroundProgress(null);
      if (failed === 0) {
        this.toast.success(`已保存 ${completed} 个文件`);
      } else {
        this.toast.error(`${failed} 个文件下载失败`, '点击可在面板中重试', {
          label: '查看',
          onClick: () => this.panel.open(),
        });
      }
    }
  }

  /* --------------------------- 其它 --------------------------- */

  private async copyLink(url: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(url);
      this.toast.success('已复制直链', '链接有效期约 2 小时');
    } catch {
      this.toast.error('复制失败', '浏览器拒绝了剪贴板访问');
    }
  }

  private openLogin(): void {
    window.open('https://www.xiaohongshu.com/', '_blank', 'noopener');
  }

  private async maybeShowCoachMark(): Promise<void> {
    const key = 'rednote.coachMarkShown';
    const stored = await chrome.storage.local.get(key);
    if (stored?.[key]) return;
    if (this.pageKind !== 'note') return;

    await chrome.storage.local.set({ [key]: true });
    this.toast.show({
      title: '点击这个按钮，就能把当前笔记的图片和视频保存下来',
      body: '在用户主页上，它还能帮你批量下载整个账号的内容。',
      duration: 7000,
    });
  }

  /**
   * 主页卡片 hover 时浮出的快捷下载按钮。
   *
   * **它必须待在面板的 shadow root 里**：
   * 之前挂在 `document.documentElement`（页面自己的 DOM），
   * 而样式表在 shadow root 里 —— 页面里的元素匹配不到 shadow root 的规则，
   * 于是 `position: fixed` 和 `opacity: 0` 全都没生效，
   * 变成一个 31×24 的灰按钮**明晃晃挂在每页左上角**
   * （2026-10-25 出商店截图时才发现）。
   * 挂进 shadow root 后样式正常，`destroy()` 时也顺带被一起清掉。
   */
  private installHoverButton(): void {
    const button = document.createElement('button');
    button.className = 'rn-hover-btn';
    button.type = 'button';
    button.setAttribute('aria-label', '下载这条笔记的全部内容');
    button.innerHTML = icon('download', 15);
    button.dataset.show = 'false';
    this.panel.shadowRoot.appendChild(button);

    let current: HTMLElement | null = null;

    const hide = () => {
      button.dataset.show = 'false';
      current = null;
    };

    button.addEventListener('click', async (event) => {
      event.preventDefault();
      event.stopPropagation();
      const anchor = current?.querySelector<HTMLAnchorElement>('a[href*="/explore/"]');
      const href = anchor?.getAttribute('href') ?? '';
      const noteId = href.match(/\/explore\/([A-Za-z0-9_-]+)/i)?.[1];
      const xsecToken = href.match(/[?&]xsec_token=([^&]+)/i)?.[1];
      if (!noteId) return;
      hide();
      this.toast.info('正在解析这条笔记…');
      const detail = await this.detector.resolveNoteDetail({
        noteId,
        xsecToken,
        title: '',
        type: 'normal',
        index: 0,
      });
      if (!detail || detail.items.length === 0) {
        this.toast.error('没有解析出可下载的资源', '可能需要登录后才能查看');
        return;
      }
      await this.startDownload(detail.items);
    });

    document.addEventListener(
      'mouseover',
      (event) => {
        if (this.pageKind !== 'profile') return;
        const target = event.target as HTMLElement | null;
        const item = target?.closest('section.note-item, .note-item') as HTMLElement | null;
        if (!item) {
          if (current) hide();
          return;
        }
        if (item === current) return;
        current = item;
        const rect = item.getBoundingClientRect();
        if (rect.width === 0) {
          hide();
          return;
        }
        button.style.right = `${window.innerWidth - rect.right + 6}px`;
        button.style.top = `${rect.top + 6}px`;
        button.dataset.show = 'true';
      },
      true,
    );

    document.addEventListener('mouseout', (event) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest('section.note-item, .note-item')) return;
      if (current) hide();
    }, true);

    window.addEventListener('scroll', () => {
      if (current) hide();
    }, { passive: true });
  }
}

const app = new App();
void app.init();
