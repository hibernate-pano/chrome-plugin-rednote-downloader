/** 扩展内部共享的数据契约 —— content script / service worker / popup 共用 */

export type MediaKind = 'video' | 'image';

export type NoteType = 'normal' | 'video';

/**
 * 文件类型筛选 —— 决定「下载哪些文件」。
 *
 * 必须是全部文件的一个**划分**：视频 + 图片 = 全部。
 * 所以视频笔记的封面（它本身就是一个图片项）算「图片」，
 * 「只下载视频」时它会被跳过。
 */
export type MediaFilter = 'all' | 'video' | 'image';

/** 笔记类型筛选 —— 决定「展示哪些笔记」（主页批量页用） */
export type NoteFilter = 'all' | 'video' | 'image';

/**
 * 保存结构 —— 决定文件落在哪种目录里。
 *
 * 三档其实只是「目录有几层」：
 * - perNote：每篇笔记一个独立文件夹（`作者/标题/1.mp4`），目录承担身份
 * - perAuthor：同一作者的内容归到一个文件夹（`作者/标题_1.mp4`）
 * - flat：全部平铺在主文件夹里（`作者_标题_1.mp4`），文件名承担身份
 *
 * 三种结构对命名模板的要求不同，所以各配一套模板（见 Settings）。
 */
export type SaveStructure = 'perNote' | 'perAuthor' | 'flat';

/** 单个可下载的媒体资源 */
export interface MediaItem {
  /** 稳定唯一 id（同一 tab 内） */
  id: string;
  kind: MediaKind;
  /** 归一化后的直链（https、去 webp 处理后缀） */
  url: string;
  /** 预览缩略图 */
  thumbUrl?: string;
  /** 建议文件名，不含目录 */
  filename: string;
  /** 字节数，未知时 undefined */
  size?: number;
  width?: number;
  height?: number;
  /** 在笔记中的序号（图片从 1 开始；视频为 0） */
  index: number;
  /** 属于哪篇笔记 */
  noteId?: string;
  noteTitle?: string;
  noteUrl?: string;
  author?: string;
  /** 视频是否为 m3u8 流（当前不支持直接落盘） */
  isStream?: boolean;
  /** 视频原始时长（秒） */
  duration?: number;
}

/** 一篇笔记的完整解析结果 */
export interface NoteInfo {
  noteId: string;
  title: string;
  desc: string;
  author: string;
  authorId?: string;
  avatar?: string;
  type: NoteType;
  /** 页面地址 */
  url: string;
  /** 媒体资源（视频 0~1 个，图片 0~18 个） */
  items: MediaItem[];
  /** 封面 */
  cover?: string;
  likedCount?: number;
  publishTime?: string;
  /** 数据来源，便于排障 */
  source: 'initial-state' | 'dom' | 'api' | 'mixed';
}

/** 主页扫描结果里的一条笔记（尚未解析媒体直链） */
export interface NoteRef {
  noteId: string;
  xsecToken?: string;
  title?: string;
  author?: string;
  type: NoteType;
  cover?: string;
  likedCount?: number;
  /** 主页上该笔记的序号 */
  index: number;
  /** 相对主页地址 */
  url?: string;
}

/** 交给 service worker 的一个下载任务项 */
export interface DownloadTaskItem {
  itemId: string;
  url: string;
  /** 相对下载目录的完整路径，例如 `昵称/标题/01.jpg` */
  filename: string;
  kind: MediaKind;
  size?: number;
  noteId?: string;
  noteTitle?: string;
  author?: string;
}

export type DownloadState =
  | 'queued'
  | 'downloading'
  | 'completed'
  | 'failed'
  | 'cancelled'
  /** 瞬时故障，正在自动重试 */
  | 'retrying'
  /** 等用户选好保存目录 */
  | 'waiting';

export interface DownloadProgress {
  taskId: string;
  itemId: string;
  downloadId?: number;
  state: DownloadState;
  bytesReceived: number;
  /** -1 表示服务器未返回 Content-Length */
  totalBytes: number;
  /** 字节/秒 */
  speed?: number;
  /** 最终落盘的完整路径 */
  filename?: string;
  error?: string;
  /** 已经自动重试过几次 */
  attempts?: number;
}

export interface TaskSummary {
  taskId: string;
  total: number;
  completed: number;
  failed: number;
  startedAt: number;
  finishedAt?: number;
}

export interface DownloadTaskSnapshot {
  taskId: string;
  items: DownloadProgress[];
  summary: TaskSummary;
}

/**
 * 下载方式 —— 决定「谁来把文件写到磁盘上」。
 *
 * - self：扩展自己取字节、自己写文件（File System Access API）。
 *   浏览器里不会留下任何下载记录，也没有浏览器的下载栏；
 *   代价是用户要先选一次保存目录。
 * - browser：走 Chrome 的下载管理器。零配置，但每个文件会在浏览器里
 *   留下一条下载记录，批量时界面也会被下载栏占掉。
 */
export type DownloadMode = 'self' | 'browser';

export interface Settings {
  /** 并发下载数 */
  concurrency: number;
  /** 下载方式：自己写盘 / 交给浏览器下载 */
  downloadMode: DownloadMode;
  /** 保存结构：每篇笔记一个独立文件夹 / 按作者分文件夹 / 全部平铺在主文件夹 */
  saveStructure: SaveStructure;
  /** 独立文件夹模式下的文件命名模板 */
  fileNameTemplate: string;
  /** 按作者分文件夹模式下的文件命名模板（作者已经在目录里，默认带上标题） */
  perAuthorFileNameTemplate: string;
  /** 全部平铺模式下的文件命名模板（文件名要自己承担身份，默认带上作者与标题） */
  flatFileNameTemplate: string;
  /** 下载目录名（相对于浏览器默认下载目录） */
  rootFolder: string;
  /** 图片格式：jpeg（统一转 JPG，保持原始分辨率）| original（保留原文件格式） */
  imageFormat: 'jpeg' | 'original';
  /** 面板主题 */
  theme: 'light' | 'dark' | 'auto';
  /** 按文件类型筛选：只下视频 / 只下图片 */
  downloadFilter: MediaFilter;
  /** 是否启用批量扫描时的自动滚动加载 */
  autoScrollScan: boolean;
  /** 批量扫描最大滚动轮数 */
  maxScrollRounds: number;
  /** 在笔记卡片上悬停时显示快捷下载按钮 */
  showHoverButton: boolean;
  /** 下载完成后发送系统通知 */
  notifyOnComplete: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  concurrency: 3,
  downloadMode: 'self',
  saveStructure: 'perNote',
  fileNameTemplate: '{index}',
  perAuthorFileNameTemplate: '{title}_{index}',
  flatFileNameTemplate: '{author}_{title}_{index}',
  rootFolder: '小红书下载',
  imageFormat: 'jpeg',
  theme: 'auto',
  downloadFilter: 'all',
  autoScrollScan: true,
  maxScrollRounds: 40,
  showHoverButton: true,
  notifyOnComplete: false,
};
