/**
 * MAIN world 桥接层。
 *
 * 为什么需要它：content script 跑在隔离世界里，读不到页面的 `window.__INITIAL_STATE__`，
 * 也用不了页面自己的签名请求函数。所以用一个 MAIN world 的 content script 作为「代理」，
 * 通过 window.postMessage 提供 RPC 能力给隔离世界调用。
 *
 * 通道密钥写在 <html> 的 data 属性上（DOM 在两个 world 之间是共享的），
 * 用来校验消息来源，避免页面伪造指令。
 */

import {
  collectNoteRefs,
  extractNoteFromState,
  extractUser,
  hasMedia,
  isObj,
  parseInitialState,
  unref,
  type RawNote,
  type RawNoteRef,
} from './detect/raw';

const CHANNEL_ATTR = 'data-rednote-channel';
/** 站点数据（__INITIAL_STATE__）就绪标记。DOM 在两个 world 间共享，隔离世界可以轮询它。 */
const STATE_ATTR = 'data-rednote-state';
const CHANNEL = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;

document.documentElement.setAttribute(CHANNEL_ATTR, CHANNEL);

/* ------------------------------------------------------------------ */
/* 抓取站点 API 响应                                                   */
/* ------------------------------------------------------------------ */

interface CapturedResponse {
  url: string;
  at: number;
  body: any;
}

const captured: CapturedResponse[] = [];
const CAPTURE_LIMIT = 60;
const CAPTURE_PATTERNS = [
  /\/api\/sns\/web\/v1\/user_posted/,
  /\/api\/sns\/web\/v1\/feed/,
  /\/api\/sns\/web\/v1\/note\/detail/,
  /\/api\/sns\/web\/v1\/user\/profile/,
];

function shouldCapture(url: string): boolean {
  return CAPTURE_PATTERNS.some((re) => re.test(url));
}

function record(url: string, body: any): void {
  captured.push({ url, at: Date.now(), body });
  if (captured.length > CAPTURE_LIMIT) captured.splice(0, captured.length - CAPTURE_LIMIT);
}

function installFetchHook(): void {
  const original = window.fetch;
  window.fetch = function patchedFetch(
    this: typeof globalThis,
    ...args: Parameters<typeof fetch>
  ): Promise<Response> {
    const url = typeof args[0] === 'string' ? args[0] : args[0] instanceof Request ? args[0].url : '';
    return original.apply(this, args).then((response) => {
      if (shouldCapture(url)) {
        try {
          response
            .clone()
            .json()
            .then((body) => record(url, body))
            .catch(() => undefined);
        } catch {
          /* ignore */
        }
      }
      return response;
    });
  } as typeof window.fetch;
}

function installXhrHook(): void {
  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function patchedOpen(
    this: XMLHttpRequest,
    method: string,
    url: string | URL,
    ...rest: unknown[]
  ) {
    (this as any).__rednoteUrl = String(url);
    return (originalOpen as any).call(this, method, url, ...rest);
  };

  XMLHttpRequest.prototype.send = function patchedSend(this: XMLHttpRequest, ...args: unknown[]) {
    this.addEventListener('load', () => {
      const url = (this as any).__rednoteUrl ?? '';
      if (!shouldCapture(url)) return;
      try {
        const body = JSON.parse(this.responseText);
        record(url, body);
      } catch {
        /* ignore */
      }
    });
    return (originalSend as any).apply(this, args);
  };
}

/* ------------------------------------------------------------------ */
/* SPA 路由变化                                                        */
/* ------------------------------------------------------------------ */

type RouteListener = (path: string) => void;
const routeListeners: RouteListener[] = [];

function currentPath(): string {
  return `${location.pathname}${location.search}`;
}

function notifyRoute(): void {
  const path = currentPath();
  for (const listener of routeListeners) {
    try {
      listener(path);
    } catch {
      /* ignore */
    }
  }
}

function installRouteHooks(): void {
  for (const method of ['pushState', 'replaceState'] as const) {
    const original = history[method];
    history[method] = function patchedHistory(...args: Parameters<typeof history.pushState>) {
      const result = original.apply(this, args);
      queueMicrotask(notifyRoute);
      return result;
    };
  }
  window.addEventListener('popstate', notifyRoute);
  window.addEventListener('hashchange', notifyRoute);
}

/* ------------------------------------------------------------------ */
/* RPC                                                                 */
/* ------------------------------------------------------------------ */

type Handler = (params: any) => any;

const handlers: Record<string, Handler> = {
  /** 当前路由 */
  route: () => currentPath(),

  /** 页面状态里当前笔记的详情 */
  'state.note': (params: { noteId?: string; loose?: boolean }) => {
    const state = (window as any).__INITIAL_STATE__;
    if (!isObj(state)) {
      // 站点在 document_start 之后才写入 __INITIAL_STATE__
      return { note: null, state: false, error: '页面数据尚未就绪' };
    }
    let note = extractNoteFromState(state, params?.noteId);
    // 笔记详情页：URL 里的 id 和状态里的对不上时（站点重定向过），
    // 退回「页面当前这条」是对的。批量解析不走这条 —— 那里拿错就是下错。
    if (!note && params?.loose) note = extractNoteFromState(state);
    return { note, state: true };
  },

  /** 主页笔记列表 */
  'state.userNotes': () => {
    const state = (window as any).__INITIAL_STATE__;
    const refs: RawNoteRef[] = collectNoteRefs(state);
    return { refs, user: extractUser(state) };
  },

  /** 已捕获的站点 API 响应 */
  'api.captured': () => captured.slice(),

  /** 驱动页面自己的 Pinia store 翻页，拿到该用户的全部笔记 */
  'profile.fetchMore': async (params: { rounds?: number }) => {
    const store = getUserStore();
    if (!store) return { ok: false, error: '页面数据源不可用' };

    const rounds = Math.max(1, Math.min(60, params?.rounds ?? 12));
    const collected: any[] = [];

    for (let i = 0; i < rounds; i += 1) {
      try {
        const query = unref(store.noteQueries)?.[0];
        if (query && query.hasMore === false) break;
        await store.fetchNotes(0);
      } catch {
        break;
      }
      await new Promise((r) => setTimeout(r, 450));
      const tab = unref(unref(store.notes)?.[0]);
      if (Array.isArray(tab)) collected.push(...tab);
    }

    return { ok: true, notes: collected };
  },

  /**
   * 取单篇笔记详情（主页批量下载时用）。
   *
   * 主路：开隐藏 iframe 加载真实笔记页，读它**渲染后**的状态。
   * 兜底：抓笔记页的 HTML，从内联的 __INITIAL_STATE__ 里抠。
   *
   * **为什么主路是 iframe 而不是抓 HTML**（2026-10-25 改）：
   * iframe 读到的是「用户眼睛看到的那份数据」—— 页面脚本跑完、XHR 回来之后的状态。
   * 抓 HTML 读到的是服务端渲染出来的那一份，两份**不一定一样**
   * （地址可能不同、清晰度可能不同、签名可能更早过期）。
   * 用户反馈「现在的下载效果还不如 1.0.0」，而 1.0.0 走的就是 iframe ——
   * 那就让 iframe 说了算，抓 HTML 只在它失败时兜底。
   *
   * **快路要自己证明自己可信才准用**：
   * 第一次解析时两条路都跑一遍，把媒体地址逐条比对 ——
   * 完全一致才说明「SSR 里那份和页面渲染那份是同一份」，之后才允许快路接手
   * （这样几百条笔记不用开几百个 iframe）；
   * 不一致就整场不用快路（宁可慢，也不能下到不一样的东西）。
   *
   * 为什么不直接调站点 API：页面的 X-s 签名依赖一整套反爬头（mnsv2 / a1 /
   * X-S-Common），site 改一次就失效，不值得依赖。
   * （实测：借站点的 X-S-Common 调 /feed 仍然是 500。）
   */
  'api.noteDetail': async (params: { noteId: string; xsecToken?: string }) => {
    const { noteId, xsecToken } = params ?? {};
    if (!noteId) return { ok: false, error: 'missing noteId' };

    // 整条链路的预算。桥接层给这个调用单独放宽了超时（默认 15s 会在这条链路上被吃光）。
    const deadline = Date.now() + NOTE_DETAIL_BUDGET_MS;

    // ---- 快路已经自证过一致 → 直接走快路（几百条笔记不用开几百个 iframe）----
    if (fastPathState === 'usable') {
      const viaFetch = await fetchNotePage(noteId, xsecToken).catch(() => null);
      if (viaFetch?.note) {
        parsePath = 'fetch';
        usedPaths.add('fetch');
        return { ok: true, note: viaFetch.note, via: 'fetch' };
      }
      // 「这条笔记的 HTML 里没有它」不代表快路坏了（可能这条笔记本来就没媒体）——
      // 只有请求本身失败才说明快路坏了，那才需要退回主路。
      if (viaFetch?.verdict === 'broken') fastPathState = 'unusable';
    }

    // ---- 主路：隐藏 iframe（1.0.0 就是这么干的）----
    const viaFrame = await loadNoteViaFrame(noteId, xsecToken, deadline).catch(() => null);
    if (viaFrame && hasMedia(viaFrame)) {
      // 页面给的东西就是权威结果。
      // 顺便让快路自证一次（不阻塞这一条：验证是后台跑的，结果只影响后面的笔记）。
      if (fastPathState === 'unknown' && viaFrame.videos.length > 0) {
        void startValidation(noteId, xsecToken, viaFrame);
      }
      parsePath = 'iframe';
      usedPaths.add('iframe');
      return { ok: true, note: viaFrame, via: 'iframe' };
    }

    // ---- 兜底：抓 HTML（页面没给出媒体的时候救一把）----
    if (fastPathState !== 'unusable') {
      const viaFetch = await fetchNotePage(noteId, xsecToken).catch(() => null);
      if (viaFetch?.note) {
        parsePath = 'fetch';
        usedPaths.add('fetch');
        return { ok: true, note: viaFetch.note, via: 'fetch' };
      }
      if (viaFetch?.verdict === 'broken') fastPathState = 'unusable';
    }

    // ---- 页面给了一个空壳：笔记在，但媒体还没出来（或者这条确实没有媒体）----
    // 这不是失败：解析确实成功了，只是这条没有可下载的东西。
    // 界面会写「未取到资源」，跟「解析失败」区分开。
    if (viaFrame) {
      parsePath = 'iframe';
      usedPaths.add('iframe');
      return { ok: true, note: viaFrame, via: 'iframe' };
    }

    return { ok: false, error: '无法获取笔记详情' };
  },

  /**
   * 这一场解析走的是哪条路（界面上要显示出来）。
   *
   * 「快路」= 抓 HTML；「页面渲染」= 隐藏 iframe。
   * 显示出来是因为两条路给的东西**可能不一样** ——
   * 用户一眼就能看出这批内容是不是按页面看到的样子下的。
   */
  'api.parsePath': () => ({
    path: parsePath,
    /** 这一场里实际用过的路 */
    paths: Array.from(usedPaths),
    fastPathState,
    /** 快路是否被证明与页面渲染结果一致 */
    fastPathTrusted: fastPathState === 'usable',
  }),
};

/** 解析一条笔记的总预算（毫秒）：隐藏 iframe + 抓 HTML 加起来不能超过它 */
const NOTE_DETAIL_BUDGET_MS = 20000;
/** 抓 HTML 单次请求的上限 —— 请求卡住时不能把整条链路耗光 */
const FETCH_TIMEOUT_MS = 5000;
/** 隐藏 iframe 等媒体补齐的上限 */
const FRAME_WAIT_MS = 10000;
/** 隐藏 iframe 里笔记已经出现、但媒体还没补上时，最多再等多久 */
const FRAME_MEDIA_WAIT_MS = 4000;

/**
 * 这一场解析实际走的是哪条路。
 */
let parsePath: 'iframe' | 'fetch' | 'none' = 'none';

/** 这一场里实际用过的路（两条都用过就都记上） */
const usedPaths = new Set<'iframe' | 'fetch'>();

/**
 * 抓 HTML 这条路的状态。
 *
 * 'unknown'  —— 还没自证过（默认：走页面，跟 1.0.0 一样）
 * 'usable'   —— 已经证明：抓到的 HTML 里的媒体地址，与页面渲染出来的**完全一致**，
 *               之后可以放心用快路（几百条笔记就不用开几百个 iframe）
 * 'unusable' —— 证明过对不上（或者压根抓不到），整场都别再试 ——
 *               每条笔记白打一个请求，还会跟 iframe 抢连接池，
 *               把解析成功率拖下去。
 */
let fastPathState: 'unknown' | 'usable' | 'unusable' = 'unknown';

/** 一次抓取的结果 */
type FetchVerdict =
  /** 拿到了这条笔记（带媒体） */
  | 'ok'
  /** 抓到了 HTML，但里面没有这条笔记 */
  | 'miss'
  /** 请求失败 / HTML 里连状态都没有 —— 这条路本身是坏的 */
  | 'broken';

/**
 * 正在进行的自证（并发时只做一次）。
 *
 * 主页批量是并发解析的：四条笔记会同时进来。
 * 如果每条都去自证，就是四次抓取 —— 白打一倍请求，还跟彼此抢连接池。
 */
let validating: Promise<void> | null = null;

/**
 * 让快路自证一次：同一条笔记，两条路都跑一遍，把**媒体地址逐条比对**。
 *
 * - 完全一致 → SSR 里那份和页面渲染那份是同一份东西，之后允许快路接手
 *   （几百条笔记就不用开几百个 iframe）
 * - 不一致 → 整场都用页面的结果。宁可慢，也不能下到不一样的东西
 *   （清晰度、地址时效都可能不一样）
 *
 * **只拿带视频的笔记去自证**：视频直链是最容易出差别的地方
 * （页面用的是 backup 地址，SSR 里可能只有 master 地址）。
 * 拿一条纯图片笔记去自证，证明不了视频那条路也靠谱。
 *
 * 不阻塞当前这条笔记：自证是后台跑的，结果只影响后面的笔记。
 */
function startValidation(
  noteId: string,
  xsecToken: string | undefined,
  frameNote: RawNote,
): Promise<void> {
  // 已经有人在自证了 → 等它的结论，别再打一次请求
  if (validating) return validating;
  // 已经有结论了 → 不用再自证
  if (fastPathState !== 'unknown') return Promise.resolve();

  const run = (async () => {
    try {
      const viaFetch = await fetchNotePage(noteId, xsecToken);
      if (!viaFetch?.note) {
        fastPathState = 'unusable';
        return;
      }
      fastPathState = sameMedia(viaFetch.note, frameNote) ? 'usable' : 'unusable';
    } catch {
      fastPathState = 'unusable';
    }
  })();
  validating = run;
  void run.finally(() => {
    if (validating === run) validating = null;
  });
  return run;
}

/**
 * 两份笔记的媒体是不是同一批东西。
 *
 * 比的是**最终会拿去下载的那个地址**（视频优先用 backup 地址），
 * 而不是原始结构 —— 结构一样但地址不同，一样是下到了不同的地方。
 *
 * 大小只在两边都有的时候才比：SSR 里可能压根没写大小，
 * 那不是「不一样」，只是「少一个字段」。
 */
function sameMedia(a: RawNote, b: RawNote): boolean {
  if (a.videos.length !== b.videos.length) return false;
  if (a.images.length !== b.images.length) return false;
  const videoKey = (v: RawNote['videos'][number]) => v.backupUrls[0] ?? v.url;
  for (let i = 0; i < a.videos.length; i += 1) {
    if (videoKey(a.videos[i]!) !== videoKey(b.videos[i]!)) return false;
    const sizeA = a.videos[i]!.size;
    const sizeB = b.videos[i]!.size;
    if (sizeA !== undefined && sizeB !== undefined && sizeA !== sizeB) return false;
  }
  for (let i = 0; i < a.images.length; i += 1) {
    if (a.images[i]!.url !== b.images[i]!.url) return false;
  }
  return true;
}

/** 真的去抓一次笔记页的 HTML */
async function fetchNotePage(
  noteId: string,
  xsecToken?: string,
): Promise<{ note: RawNote | null; verdict: FetchVerdict }> {
  const url = `/explore/${encodeURIComponent(noteId)}${xsecToken ? `?xsec_token=${encodeURIComponent(xsecToken)}` : ''}`;
  let html: string;
  // 必须自己掐表：站点的响应可能很慢（甚至挂着），
  // 不设上限的话这一次请求就能把整条链路的预算吃光。
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      credentials: 'include',
      signal: controller.signal,
    });
    if (!response.ok) return { note: null, verdict: 'broken' };
    html = await response.text();
  } catch {
    return { note: null, verdict: 'broken' };
  } finally {
    clearTimeout(timer);
  }

  // 站点的状态是 JavaScript 对象字面量（里面带 undefined），
  // 不是合法 JSON —— parseInitialState 做了容错处理，抠不出来就是没有状态。
  const state = parseInitialState(html);
  if (!state) return { note: null, verdict: 'broken' };

  const note = extractNoteFromState(state, noteId);
  if (note) {
    // 抠到了但没有媒体 = 拿到的是个空壳，等于没解析出来
    if (!hasMedia(note)) return { note: null, verdict: 'miss' };
    return { note, verdict: 'ok' };
  }

  // 压根没抠到这条笔记。再看一眼状态里有没有「笔记详情」这一块：
  //   - 有详情、只是里面没有我们这条 → 这条笔记特殊，算一次 miss
  //   - 连详情块都是空的 → 站点压根不把详情渲染进 HTML。
  //     实测（2026-10-24 真实站点）：笔记页 SSR 里的 noteDetailMap 就是空的，
  //     详情是页面 JS 跑起来之后用 XHR 拉的 ——
  //     这种站点上快路是白费的，认出来就能整场都别再试。
  const noteState = unref((state as any)?.note);
  const detailMap = unref(noteState?.noteDetailMap);
  const hasDetails =
    detailMap && typeof detailMap === 'object' && Object.keys(detailMap).length > 0;
  return { note: null, verdict: hasDetails ? 'miss' : 'broken' };
}

/**
 * 用隐藏 iframe 加载笔记页，读取它的 __INITIAL_STATE__。
 *
 * **媒体是后补的，所以要给它一点时间。**
 * 页面的状态是一点点填进来的：一开始只有 id、标题这些，
 * 视频直链是后面 XHR 回来才补上的。
 * 笔记一出现就先记下来，最多再等 4 秒让媒体补齐；
 * 补上了就用带媒体的这份，补不上也把笔记返回 ——
 * 判成「解析失败」是不诚实的（这条笔记确实解析出来了，只是它没有可下载的资源），
 * 但也不能干等十几秒：几百条笔记那样等下去就没完了。
 *
 * deadline 是整条链路的截止时间（抓 HTML 可能已经花掉几秒），
 * 不能在这里又从头给一份完整预算。
 */
async function loadNoteViaFrame(
  noteId: string,
  xsecToken: string | undefined,
  deadline: number,
): Promise<RawNote | null> {
  const url = `/explore/${encodeURIComponent(noteId)}${xsecToken ? `?xsec_token=${encodeURIComponent(xsecToken)}` : ''}`;
  const frame = document.createElement('iframe');
  frame.style.cssText =
    'position:fixed;left:-99999px;top:0;width:1280px;height:800px;border:0;visibility:hidden;';
  frame.src = url;
  document.body.appendChild(frame);

  try {
    // 笔记页是 SSR 的，状态内联在 HTML 里，实测 370ms 就能读到。
    const end = Math.min(deadline, Date.now() + FRAME_WAIT_MS);
    let shell: RawNote | null = null;
    let shellAt = 0;
    while (Date.now() < end) {
      await new Promise((r) => setTimeout(r, 80));
      let state: any = null;
      try {
        state = (frame.contentWindow as any)?.__INITIAL_STATE__;
      } catch {
        state = null;
      }
      if (!state) continue;
      const note = extractNoteFromState(state, noteId);
      if (!note) continue;
      // 有媒体 —— 直接用
      if (hasMedia(note)) return note;
      // 空壳 —— 记下来，等媒体补齐
      if (!shell) {
        shell = note;
        shellAt = Date.now();
      } else if (Date.now() - shellAt > FRAME_MEDIA_WAIT_MS) {
        // 等够了还是没有媒体 —— 这条笔记就是没有可下载的资源
        return shell;
      }
    }
    // 状态一直没出现：算失败
    return shell;
  } finally {
    frame.remove();
  }
}

/** 拿到站点 Pinia 里的 user store（页面内部数据源） */
function getUserStore(): any {
  const app = document.querySelector('#app') as any;
  const pinia = app?.__vue_app__?.config?.globalProperties?.$pinia;
  const stores = pinia?._s;
  if (!stores) return null;
  return stores.get('user') ?? null;
}

/* ------------------------------------------------------------------ */
/* 消息通道                                                            */
/* ------------------------------------------------------------------ */

/** 把任何异常值描述成可读文本（保留堆栈，方便线上排障） */
function describeError(err: unknown): string {
  try {
    if (err instanceof Error) {
      return `${err.name}: ${err.message}${err.stack ? `\n${err.stack.slice(0, 600)}` : ''}`;
    }
    if (err && typeof err === 'object') {
      const keys = Object.keys(err as object).slice(0, 8).join(',');
      return `non-Error(${keys}): ${String(err)}`;
    }
    return `raw: ${String(err)} (${typeof err})`;
  } catch {
    return '无法描述的异常';
  }
}

window.addEventListener('message', (event) => {
  if (event.source !== window) return;
  const data = event.data;
  if (!isObj(data) || data.__rednote !== CHANNEL) return;

  const { id, method, params } = data as { id: string; method: string; params?: any };

  // 只处理请求。自己的响应也会被 window 收到（没有 method），
  // 如果不拦下来就会「响应 → 再当请求 → 再响应」形成无限消息风暴。
  if (typeof method !== 'string' || !method) return;

  if (method === '__subscribeRoute') {
    routeListeners.push((path) => {
      window.postMessage({ __rednote: CHANNEL, id: `${id}:route`, event: 'route', path }, '*');
    });
    window.postMessage({ __rednote: CHANNEL, id, ok: true, result: currentPath() }, '*');
    return;
  }

  const handler = handlers[method];
  if (!handler) {
    window.postMessage({ __rednote: CHANNEL, id, ok: false, error: `unknown method: ${method}` }, '*');
    return;
  }

  Promise.resolve()
    .then(() => handler(params))
    .then((result) => {
      window.postMessage({ __rednote: CHANNEL, id, ok: true, result }, '*');
    })
    .catch((err: unknown) => {
      window.postMessage({ __rednote: CHANNEL, id, ok: false, error: describeError(err) }, '*');
    });
});

/* ------------------------------------------------------------------ */
/* 启动                                                                */
/* ------------------------------------------------------------------ */

installFetchHook();
installXhrHook();
installRouteHooks();

// 站点可能稍后才写入 __INITIAL_STATE__，定时探测并通知一次就绪
let stateReadyNotified = false;
const stateTimer = setInterval(() => {
  if (stateReadyNotified) {
    clearInterval(stateTimer);
    return;
  }
  if ((window as any).__INITIAL_STATE__) {
    stateReadyNotified = true;
    clearInterval(stateTimer);
    // DOM 属性跨 world 可见，隔离世界靠它判断「可以开始识别了」
    document.documentElement.setAttribute(STATE_ATTR, '1');
    window.postMessage({ __rednote: CHANNEL, event: 'stateReady' }, '*');
  }
}, 120);

window.postMessage({ __rednote: CHANNEL, event: 'hello', path: currentPath() }, '*');

// 供 ISOLATED world 读取用的兜底导出
Object.defineProperty(window, '__rednoteBridge', {
  value: { channel: CHANNEL, version: 1 },
  configurable: true,
});

export {};
