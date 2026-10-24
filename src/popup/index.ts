import { MSG } from '../shared/messages';
import type { Settings } from '../shared/types';
import { DEFAULT_SETTINGS } from '../shared/types';
import { formatBytes } from '../shared/utils';
import { icon, logoSvg } from '../content/ui/icons';

interface PageInfo {
  kind: 'note' | 'profile' | 'unknown';
  title?: string;
  author?: string;
  cover?: string;
  items?: number;
  videos?: number;
  images?: number;
}

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

async function getSettings(): Promise<Settings> {
  try {
    const res = await chrome.runtime.sendMessage({ type: MSG.GET_SETTINGS });
    return { ...DEFAULT_SETTINGS, ...(res?.settings ?? {}) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

async function saveSettings(patch: Partial<Settings>): Promise<void> {
  await chrome.runtime.sendMessage({ type: MSG.SAVE_SETTINGS, settings: patch });
}

async function activeTab(): Promise<chrome.tabs.Tab | undefined> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function fetchPageInfo(tabId: number): Promise<PageInfo | null> {
  try {
    const res = await chrome.tabs.sendMessage(tabId, { type: 'GET_PAGE_INFO' });
    return (res?.info as PageInfo) ?? null;
  } catch {
    return null;
  }
}

function renderCurrent(info: PageInfo | null): void {
  const thumb = $('current-thumb');
  const title = $('current-title');
  const sub = $('current-sub');
  const open = $<HTMLButtonElement>('btn-open');

  if (!info || info.kind === 'unknown') {
    thumb.innerHTML = icon('info', 20);
    title.textContent = '打开小红书笔记或用户主页';
    sub.textContent = '就可以开始下载了';
    open.hidden = true;
    return;
  }

  if (info.cover) {
    thumb.innerHTML = `<img src="${info.cover}" alt="" />`;
  } else {
    thumb.innerHTML = icon(info.kind === 'profile' ? 'grid' : 'gallery', 20);
  }

  if (info.kind === 'note') {
    title.textContent = info.title || '当前笔记';
    const bits: string[] = [];
    if (info.videos) bits.push(`${info.videos} 个视频`);
    if (info.images) bits.push(`${info.images} 张图片`);
    sub.textContent = bits.length ? bits.join(' · ') : '暂无可下载内容';
    open.hidden = false;
    open.textContent = info.items ? `打开下载面板 (${info.items})` : '打开下载面板';
  } else {
    title.textContent = info.title || '用户主页';
    sub.textContent = '打开面板后可批量扫描并选择下载';
    open.hidden = false;
    open.textContent = '打开批量下载面板';
  }
}

async function init(): Promise<void> {
  $('logo').innerHTML = logoSvg(15);
  $('btn-options').innerHTML = icon('gear', 16);

  const settings = await getSettings();

  const hover = $<HTMLInputElement>('opt-hover');
  const notify = $<HTMLInputElement>('opt-notify');
  hover.checked = settings.showHoverButton;
  notify.checked = settings.notifyOnComplete;
  hover.addEventListener('change', () => void saveSettings({ showHoverButton: hover.checked }));
  notify.addEventListener('change', () => void saveSettings({ notifyOnComplete: notify.checked }));

  const tab = await activeTab();
  if (tab?.id) {
    const info = await fetchPageInfo(tab.id);
    renderCurrent(info);

    $<HTMLButtonElement>('btn-open').addEventListener('click', () => {
      void chrome.tabs.sendMessage(tab.id!, { type: 'OPEN_PANEL' }).then(() => window.close());
    });
  } else {
    renderCurrent(null);
  }

  // 会话统计
  try {
    const res = await chrome.runtime.sendMessage({ type: MSG.GET_SESSION_STATS });
    const stats = res?.stats as { completed: number; bytes: number } | undefined;
    if (stats && stats.completed > 0) {
      $('stats').hidden = false;
      $('stats-num').textContent = String(stats.completed);
      $('stats-label').textContent = `本次会话已下载 ${stats.completed} 个文件 · ${formatBytes(stats.bytes)}`;
    }
  } catch {
    /* ignore */
  }

  $('btn-options').addEventListener('click', () => {
    void chrome.runtime.openOptionsPage();
    window.close();
  });

  $('ft-help').addEventListener('click', () => {
    void chrome.tabs.create({ url: 'https://www.xiaohongshu.com/explore' });
    window.close();
  });

  const version = chrome.runtime.getManifest().version;
  $('ft-version').textContent = `v${version}`;
}

void init();
