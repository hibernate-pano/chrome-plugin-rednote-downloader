import { MSG, type DirectoryState } from '../shared/messages';
import { getRootHandle, queryPermission, setRootHandle } from '../shared/fs-store';
import { logoSvg } from '../content/ui/icons';

/**
 * 选保存目录的小窗口。
 *
 * 必须是扩展自己的页面：内容脚本里拿到的目录句柄绑定的是小红书这个站点的
 * origin，存不进扩展、也交不了 Service Worker；扩展页面拿到的句柄才绑定扩展的
 * origin，Service Worker 能从 IndexedDB 里读出来接着写。
 */
const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

/** 触发这个窗口的任务：用户关掉窗口时只取消它，不影响别的标签页 */
const taskId = new URLSearchParams(location.search).get('task') ?? undefined;

/** 已经处理完了（选好了 / 切到浏览器下载），关窗时不要再报取消 */
let settled = false;

/** 已有目录但授权过期时，走「重新授权」而不是重新选目录 */
let regrantHandle: FileSystemDirectoryHandle | null = null;
let needRegrant = false;

function setNote(text: string, isError = false): void {
  const note = $('note');
  note.textContent = text;
  note.classList.toggle('err', isError);
}

function render(state: DirectoryState | undefined): void {
  const dot = $('state-dot');
  const text = $('state-text');
  const pick = $<HTMLButtonElement>('btn-pick');
  const lead = $('lead');

  if (!state?.hasDirectory) {
    dot.className = 'state-dot';
    text.textContent = '还没有设置保存目录';
    text.classList.add('muted');
    pick.textContent = '选择文件夹';
    lead.textContent = '选一个文件夹，之后下载的内容会直接存进去。';
    setNote('选完之后浏览器里不会留下下载记录，文件也整整齐齐。');
    return;
  }

  if (state.permission === 'granted') {
    dot.className = 'state-dot on';
    text.textContent = state.name ?? '已选择';
    text.classList.remove('muted');
    pick.textContent = '换一个文件夹';
    lead.textContent = '已经可以直接下载了。';
    setNote('想换地方的话，点上面的按钮重新选一个。');
    return;
  }

  dot.className = 'state-dot warn';
  text.textContent = state.name ?? '已选择';
  text.classList.remove('muted');
  pick.textContent = '重新授权';
  lead.textContent = '浏览器重启后需要再授权一次。';
  setNote('点一下按钮，把继续写文件的权限交回来。');
}

/**
 * 选目录。
 *
 * showDirectoryPicker 和 requestPermission 都要求「用户手势」，
 * 所以必须在点击回调里**第一件事**就调用它们 ——
 * 前面任何一次 await 都会把用户激活状态消耗掉，调用就会直接失败。
 */
function onPick(): void {
  const pick = $<HTMLButtonElement>('btn-pick');
  pick.disabled = true;

  if (needRegrant && regrantHandle) {
    const handle = regrantHandle;
    void handle
      .requestPermission({ mode: 'readwrite' })
      .then(async (state) => {
        if (state !== 'granted') {
          setNote('没有拿到授权，无法写入这个文件夹。', true);
          return;
        }
        await chrome.runtime.sendMessage({ type: MSG.DIRECTORY_READY, name: handle.name });
        settled = true;
        window.close();
      })
      .catch((err: unknown) => {
        setNote(err instanceof Error ? err.message : String(err), true);
      })
      .finally(() => {
        pick.disabled = false;
      });
    return;
  }

  void (async () => {
    try {
      const handle = await window.showDirectoryPicker({
        mode: 'readwrite',
        id: 'rednote-downloads',
        startIn: 'downloads',
      });
      await setRootHandle(handle);
      await chrome.runtime.sendMessage({ type: MSG.DIRECTORY_READY, name: handle.name });
      settled = true;
      window.close();
    } catch (err) {
      // 用户在系统对话框里点了取消 —— 不算错误
      if (err instanceof Error && err.name === 'AbortError') {
        setNote('已取消。也可以直接关掉这个窗口。');
      } else {
        setNote(err instanceof Error ? err.message : String(err), true);
      }
    } finally {
      pick.disabled = false;
    }
  })();
}

/** 用户不想用扩展自己的保存方式，改回浏览器下载 */
function onUseBrowser(): void {
  void chrome.runtime.sendMessage({ type: MSG.USE_BROWSER_DOWNLOAD }).then(() => {
    settled = true;
    window.close();
  });
}

async function init(): Promise<void> {
  $('logo').innerHTML = logoSvg(14);

  let state: DirectoryState | undefined;
  try {
    const res = await chrome.runtime.sendMessage({ type: MSG.GET_DIRECTORY_STATE });
    state = res?.state as DirectoryState | undefined;
  } catch {
    /* ignore */
  }
  render(state);

  if (state?.hasDirectory && state.permission !== 'granted') {
    const handle = await getRootHandle();
    if (handle) {
      regrantHandle = handle;
      needRegrant = true;
    }
  }

  $('btn-pick').addEventListener('click', onPick);
  $('btn-browser').addEventListener('click', onUseBrowser);

  // 窗口被关掉 = 用户不打算选目录：把等着这个目录的任务取消掉
  window.addEventListener('pagehide', () => {
    if (settled) return;
    void chrome.runtime.sendMessage({ type: MSG.DIRECTORY_CANCELLED, taskId });
  });
}

void init();
