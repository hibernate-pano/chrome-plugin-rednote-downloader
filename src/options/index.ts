import { MSG, type DirectoryState } from '../shared/messages';
import type { DownloadMode, SaveStructure, Settings } from '../shared/types';
import { DEFAULT_SETTINGS } from '../shared/types';
import {
  effectiveTemplate,
  sanitizeSegment,
  saveStructureLabel,
  SAVE_STRUCTURE_HINTS,
} from '../shared/utils';
import { buildFileName } from '../content/detect/media';
import { logoSvg } from '../content/ui/icons';
import { clearRootHandle, getRootHandle, queryPermission, setRootHandle } from '../shared/fs-store';

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

let settings: Settings = { ...DEFAULT_SETTINGS };
/** 读取设置失败时的原因，会显示给用户（而不是静默退回默认值） */
let loadError = '';

/** 带超时的消息调用：background 没响应时不能无限期挂起 */
function sendMessage<T>(message: unknown, timeoutMs = 4000): Promise<T> {
  return Promise.race([
    chrome.runtime.sendMessage(message) as Promise<T>,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error('后台服务没有响应，请重新加载扩展')), timeoutMs),
    ),
  ]);
}

/** 当前保存目录的状态 */
let directory: DirectoryState | undefined;

async function loadDirectory(): Promise<void> {
  try {
    const res = await sendMessage<{ state?: DirectoryState }>({ type: MSG.GET_DIRECTORY_STATE });
    directory = res?.state;
  } catch {
    directory = undefined;
  }
}

/** 目录那一行的显示：设了没、叫什么、授权还在不在 */
function renderDirectory(): void {
  const hint = $('directoryHint');
  const row = $('row-directory');
  const clear = $<HTMLButtonElement>('btn-clear-dir');
  if (!directory?.hasDirectory) {
    hint.textContent = '还没有选择文件夹 —— 下载时会弹出窗口让你选一次';
    row.classList.remove('hidden');
    clear.hidden = true;
    return;
  }
  if (directory.permission === 'granted') {
    hint.textContent = `当前：${directory.name ?? '已选择'}`;
  } else {
    hint.textContent = `当前：${directory.name ?? '已选择'}（需要重新授权才能继续写入）`;
  }
  row.classList.remove('hidden');
  clear.hidden = false;
}

async function load(): Promise<void> {
  try {
    const res = await sendMessage<{ settings?: Partial<Settings> }>({ type: MSG.GET_SETTINGS });
    settings = { ...DEFAULT_SETTINGS, ...(res?.settings ?? {}) };
  } catch (err) {
    settings = { ...DEFAULT_SETTINGS };
    loadError = err instanceof Error ? err.message : String(err);
  }
}

let toastTimer: ReturnType<typeof setTimeout> | null = null;
function toast(message: string): void {
  const el = $('toast');
  el.textContent = message;
  el.dataset.show = 'true';
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.dataset.show = 'false';
  }, 1800);
}

async function save(patch: Partial<Settings>): Promise<void> {
  settings = { ...settings, ...patch };
  await chrome.runtime.sendMessage({ type: MSG.SAVE_SETTINGS, settings: patch });
}

/**
 * 命名模板有三套：三种保存结构各配一套。
 *
 * 结构对模板的要求不同 —— 独立文件夹的目录里已经有「作者/标题」，
 * 文件名用序号就够；按作者分文件夹时标题得进文件名；
 * 全部平铺时文件名是唯一的身份标识，必须带作者与标题。
 * 界面只显示当前结构对应的那一套，避免几套模板互相覆盖。
 */
function currentTemplate(settings: Settings): string {
  // 用 effectiveTemplate：模板被清空时显示的是生效的默认值，而不是空串
  return effectiveTemplate(settings);
}

/** 当前结构对应的模板字段名 */
function templateField(structure: SaveStructure): keyof Settings {
  if (structure === 'flat') return 'flatFileNameTemplate';
  if (structure === 'perAuthor') return 'perAuthorFileNameTemplate';
  return 'fileNameTemplate';
}

function updatePreview(): void {
  const preview = $('preview');
  try {
    const sample = buildFileName(settings, {
      author: '小美爱拍照',
      title: '周末京都｜红叶季人少又好拍',
      index: 1,
      ext: 'jpg',
    });
    const root = sanitizeSegment(settings.rootFolder || '小红书下载');
    let folder = `${root}/`;
    if (settings.saveStructure === 'perNote') {
      folder += `${sanitizeSegment('小美爱拍照')}/${sanitizeSegment('周末京都｜红叶季人少又好拍')}/`;
    } else if (settings.saveStructure === 'perAuthor') {
      folder += `${sanitizeSegment('小美爱拍照')}/`;
    }
    preview.innerHTML = `保存为 <b>${folder}${sample}</b>`;

    // 全部平铺时没有目录帮忙区分，模板必须自己带上身份
    if (
      settings.saveStructure === 'flat' &&
      !/\{(title|author)\}/.test(effectiveTemplate(settings))
    ) {
      const hint = document.createElement('div');
      hint.className = 'preview-hint';
      hint.textContent =
        '所有文件都平铺在主文件夹里，只用序号会分不清不同笔记，建议改用「作者_标题_序号」模板。';
      preview.appendChild(hint);
    }
  } catch (err) {
    preview.textContent = `预览失败：${err instanceof Error ? err.message : String(err)}`;
  }
}

function bindSegment(id: string, onPick: (value: string) => void): void {
  const container = $(id);
  const buttons = Array.from(container.querySelectorAll('button'));
  buttons.forEach((button) => {
    button.addEventListener('click', () => {
      const value = button.dataset.value!;
      onPick(value);
      buttons.forEach((b) =>
        b.setAttribute('aria-pressed', String(b.dataset.value === value)),
      );
    });
  });
}

function markSegment(id: string, value: string): void {
  const container = $(id);
  container.querySelectorAll('button').forEach((b) => {
    b.setAttribute('aria-pressed', String(b.dataset.value === value));
  });
}

/** 把致命错误显示在页面上，而不是让页面白屏 */
function showFatal(message: string): void {
  const banner = document.createElement('div');
  banner.className = 'banner';
  banner.textContent = message;
  document.querySelector('.wrap')?.prepend(banner);
}

window.addEventListener('error', (event) => showFatal(`页面出错了：${event.message}`));
window.addEventListener('unhandledrejection', (event) => {
  showFatal(`页面出错了：${String((event as PromiseRejectionEvent).reason)}`);
});

async function init(): Promise<void> {
  $('logo').innerHTML = logoSvg(22);
  await load();

  const rootFolder = $<HTMLInputElement>('rootFolder');
  const fileNameTemplate = $<HTMLInputElement>('fileNameTemplate');
  const autoScrollScan = $<HTMLInputElement>('autoScrollScan');
  const maxScrollRounds = $<HTMLInputElement>('maxScrollRounds');
  const showHoverButton = $<HTMLInputElement>('showHoverButton');
  const notifyOnComplete = $<HTMLInputElement>('notifyOnComplete');

  rootFolder.value = settings.rootFolder;
  fileNameTemplate.value = currentTemplate(settings);
  autoScrollScan.checked = settings.autoScrollScan;
  maxScrollRounds.value = String(settings.maxScrollRounds);
  showHoverButton.checked = settings.showHoverButton;
  notifyOnComplete.checked = settings.notifyOnComplete;

  await loadDirectory();
  markSegment('seg-downloadMode', settings.downloadMode);
  renderDirectory();

  markSegment('seg-concurrency', String(settings.concurrency));
  markSegment('seg-theme', settings.theme);
  markSegment('seg-imageFormat', settings.imageFormat);
  markSegment('seg-downloadFilter', settings.downloadFilter);
  markSegment('seg-saveStructure', settings.saveStructure);
  syncTemplateScope();

  /** 切结构时同步：模板输入框显示的是当前结构那套，说明文字也换掉 */
  function syncTemplateScope(): void {
    $('templateScope').textContent = saveStructureLabel(settings.saveStructure);
    $('saveStructureHint').textContent = SAVE_STRUCTURE_HINTS[settings.saveStructure];
    fileNameTemplate.value = currentTemplate(settings);
  }

  bindSegment('seg-concurrency', (value) => {
    void save({ concurrency: Number(value) });
    toast('已保存');
  });
  bindSegment('seg-theme', (value) => {
    void save({ theme: value as Settings['theme'] });
    toast('已保存');
  });
  bindSegment('seg-imageFormat', (value) => {
    void save({ imageFormat: value as Settings['imageFormat'] });
    toast('已保存');
  });
  bindSegment('seg-downloadFilter', (value) => {
    void save({ downloadFilter: value as Settings['downloadFilter'] });
    toast('已保存');
  });
  bindSegment('seg-downloadMode', (value) => {
    const mode = value as DownloadMode;
    void save({ downloadMode: mode }).then(() => {
      renderDirectory();
    });
    toast('已保存');
  });

  $<HTMLButtonElement>('btn-pick-dir').addEventListener('click', () => {
    // showDirectoryPicker 要求用户手势，必须在点击回调里第一件事就调
    void window
      .showDirectoryPicker({ mode: 'readwrite', id: 'rednote-downloads', startIn: 'downloads' })
      .then(async (handle) => {
        await setRootHandle(handle);
        await chrome.runtime.sendMessage({ type: MSG.DIRECTORY_READY, name: handle.name });
        await loadDirectory();
        renderDirectory();
        toast(`已保存到「${handle.name}」`);
      })
      .catch((err: unknown) => {
        if (err instanceof Error && err.name === 'AbortError') return;
        toast(err instanceof Error ? err.message : String(err));
      });
  });

  $<HTMLButtonElement>('btn-clear-dir').addEventListener('click', () => {
    void (async () => {
      await chrome.runtime.sendMessage({ type: MSG.CLEAR_DIRECTORY });
      await clearRootHandle();
      await loadDirectory();
      renderDirectory();
      toast('已清除');
    })();
  });

  bindSegment('seg-saveStructure', (value) => {
    const structure = value as SaveStructure;
    void save({ saveStructure: structure }).then(() => {
      syncTemplateScope();
      updatePreview();
    });
    toast('已保存');
  });

  rootFolder.addEventListener('input', () => {
    void save({ rootFolder: rootFolder.value });
    updatePreview();
  });
  fileNameTemplate.addEventListener('input', () => {
    const patch: Partial<Settings> = {
      [templateField(settings.saveStructure)]: fileNameTemplate.value,
    } as Partial<Settings>;
    void save(patch);
    updatePreview();
  });
  autoScrollScan.addEventListener('change', () => {
    void save({ autoScrollScan: autoScrollScan.checked });
    toast('已保存');
  });
  maxScrollRounds.addEventListener('change', () => {
    const value = Math.max(1, Math.min(200, Number(maxScrollRounds.value) || 40));
    maxScrollRounds.value = String(value);
    void save({ maxScrollRounds: value });
    toast('已保存');
  });
  showHoverButton.addEventListener('change', () => {
    void save({ showHoverButton: showHoverButton.checked });
    toast('已保存');
  });
  notifyOnComplete.addEventListener('change', () => {
    void save({ notifyOnComplete: notifyOnComplete.checked });
    toast('已保存');
  });

  $('quickTemplates')
    .querySelectorAll('button')
    .forEach((button) => {
      button.addEventListener('click', () => {
        const tpl = (button as HTMLElement).dataset.tpl!;
        fileNameTemplate.value = tpl;
        const patch: Partial<Settings> = {
          [templateField(settings.saveStructure)]: tpl,
        } as Partial<Settings>;
        void save(patch);
        updatePreview();
        toast('已保存');
      });
    });

  $('version').textContent = chrome.runtime.getManifest().version;
  updatePreview();

  if (loadError) {
    showFatal(`读取设置失败：${loadError}。当前显示的是默认值。`);
  }
}

void init().catch((err) => showFatal(`设置页初始化失败：${err instanceof Error ? err.message : String(err)}`));
