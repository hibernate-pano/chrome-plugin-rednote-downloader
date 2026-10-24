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
   * 主路：抓笔记页的 HTML，直接把内联的 __INITIAL_STATE__ 解析出来。
   * 笔记页是服务端渲染的，状态就写在 HTML 里 —— 拿 HTML 只需要网络开销，
   * 不需要浏览器真的去渲染一个页面。
   *
   * 兜底：开隐藏 iframe 加载笔记页，读它渲染后的状态。
   *
   * 为什么主路换成抓 HTML：主页批量几百条笔记时，
   * 每条都开一个 iframe 等于让浏览器加载并执行几百个完整页面 ——
   * 实测几百条之后浏览器会明显变卡、页面请求都发不出去。
   * 抓 HTML 是同样数量的轻量请求，没有渲染、没有脚本执行，快一个量级。
   *
   * **但这条路不能用「每条笔记都试一次」的笨办法**：
   * 抓 HTML 和 iframe 加载走的是同一个站点、同一个连接池（浏览器每个域名 6 条）。
   * 多打一遍等于把站点的压力翻倍，iframe 反而被挤掉 ——
   * 表现出来就是「解析经常失败」。
   * 所以先试第一条，判定这条路通不通，之后整个会话只走一条路。
   * （判定依据见 fetchPathState）
   *
   * 为什么不直接调站点 API：页面的 X-s 签名依赖一整套反爬头（mnsv2 / a1 /
   * X-S-Common），site 改一次就失效，不值得依赖。
   * （实测：借站点的 X-S-Common 调 /feed 仍然是 500。）
   */
  'api.noteDetail': async (params: { noteId: string; xsecToken?: string }) => {
    const { noteId, xsecToken } = params ?? {};
    if (!noteId) return { ok: false, error: 'missing noteId' };

    // 整条链路的预算：抓 HTML 最多 5s，剩下的时间留给隐藏 iframe。
    // 桥接层给这个调用单独放宽了超时（默认 15s 会在这条链路上被吃光）。
    const deadline = Date.now() + NOTE_DETAIL_BUDGET_MS;

    // 主路：抓 HTML
    if (fetchPathState !== 'unusable') {
      try {
        const result = await loadNoteViaFetch(noteId, xsecToken);
        if (result.note) {
          fetchMisses = 0;
          fetchPathState = 'usable';
          return { ok: true, note: result.note, via: 'fetch' };
        }
        if (result.verdict === 'broken') {
          // 这条路本身坏了（请求失败、HTML 里连状态都没有）—— 整场都别再试
          fetchPathState = 'unusable';
        } else {
          // 抓到了 HTML，但里面没有这条笔记。
          // 可能是这条笔记特殊，也可能是站点压根不把详情渲染进 HTML ——
          // 连着几次都这样就别再试了（每次试都是白打一个请求）。
          fetchMisses += 1;
          if (fetchMisses >= FETCH_MISS_LIMIT) fetchPathState = 'unusable';
        }
      } catch {
        fetchPathState = 'unusable';
      }
    }

    // 兜底：隐藏 iframe
    try {
      const note = await loadNoteViaFrame(noteId, xsecToken, deadline);
      if (note) return { ok: true, note, via: 'iframe' };
    } catch {
      /* ignore */
    }

    return { ok: false, error: '无法获取笔记详情' };
  },
};

/** 解析一条笔记的总预算（毫秒）：抓 HTML + 隐藏 iframe 加起来不能超过它 */
const NOTE_DETAIL_BUDGET_MS = 20000;
/** 抓 HTML 单次请求的上限 —— 请求卡住时不能把整条链路耗光 */
const FETCH_TIMEOUT_MS = 5000;
/** 隐藏 iframe 等媒体补齐的上限 */
const FRAME_WAIT_MS = 10000;
/** 连续几次「抓到了 HTML 但没有这条笔记」之后，判定快路不可用 */
const FETCH_MISS_LIMIT = 3;

/**
 * 抓 HTML 这条路通不通。
 *
 * 'unknown'  —— 还没试过
 * 'usable'   —— 抓到的 HTML 里有这条笔记的详情，往后就走快路
 * 'unusable' —— 这条路对站点不管用，整场都别再试 ——
 *               每条笔记白打一个请求，还会跟 iframe 抢连接池，
 *               把解析成功率拖下去。
 */
let fetchPathState: 'unknown' | 'usable' | 'unusable' = 'unknown';

/** 连续「抓到 HTML 但没有目标笔记」的次数 */
let fetchMisses = 0;

/**
 * 读一下当前判定。
 *
 * 单独写成函数是因为 TypeScript 会在函数内把变量收窄，
 * 而这里等 await 之后别的函数可能已经改过它了。
 */
function isFetchPathUnusable(): boolean {
  return fetchPathState === 'unusable';
}

/** 一次抓取的结果 */
type FetchVerdict =
  /** 拿到了这条笔记（带媒体） */
  | 'ok'
  /** 抓到了 HTML，但里面没有这条笔记 */
  | 'miss'
  /** 请求失败 / HTML 里连状态都没有 —— 这条路本身是坏的 */
  | 'broken';

/**
 * 正在进行的探测。
 *
 * 主页批量是**并发**解析的：三条笔记会同时开抓。
 * 如果只靠一个布尔标记，三条会各自抓一次 ——
 * 「只多花一次请求」的保证就没了，等于把站点压力翻倍。
 * 所以第一条在抓的时候，后面的等它的结论：
 *   - 结论是「这条路坏了」 → 后面直接放弃，一次请求都不多打
 *   - 结论是「这条路行」  → 后面各自去抓自己那条（每条笔记的 HTML 都不一样）
 */
let fetchProbe: Promise<{ note: RawNote | null; verdict: FetchVerdict }> | null = null;

/**
 * 抓笔记页的 HTML，从里面解析出笔记详情。
 */
async function loadNoteViaFetch(
  noteId: string,
  xsecToken?: string,
): Promise<{ note: RawNote | null; verdict: FetchVerdict }> {
  // 已经判定这条路不行了 → 一次请求都不多打
  if (isFetchPathUnusable()) return { note: null, verdict: 'broken' };

  // 已经有人在探路了 → 等它的结论，别再打一次请求
  if (fetchProbe) {
    await fetchProbe.catch(() => undefined);
    if (isFetchPathUnusable()) return { note: null, verdict: 'broken' };
    return await fetchNotePage(noteId, xsecToken);
  }

  fetchProbe = fetchNotePage(noteId, xsecToken);
  try {
    return await fetchProbe;
  } finally {
    fetchProbe = null;
  }
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
 * **必须等到笔记里真的有媒体才算数。**
 * 页面的状态是一点点填进来的：一开始只有 id、标题这些，
 * 视频直链是后面 XHR 回来才补上的。
 * 早返回一步就会拿到一个「有 id 没视频」的空壳 ——
 * 界面上表现为「解析成功了，但一个视频都没有」，而且不会重试、不会报错。
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
    // 但媒体是后补的，所以要给足时间。
    const end = Math.min(deadline, Date.now() + FRAME_WAIT_MS);
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
      // 空壳不算 —— 继续等媒体补上
      if (!hasMedia(note)) continue;
      return note;
    }
    return null;
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
