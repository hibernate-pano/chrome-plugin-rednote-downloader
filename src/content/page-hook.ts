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
  isObj,
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
   * 为什么不直接调站点 API：页面的 X-s 签名依赖一整套反爬头（mnsv2 / a1 /
   * X-S-Common），site 改一次就失效，不值得依赖。
   */
  'api.noteDetail': async (params: { noteId: string; xsecToken?: string }) => {
    const { noteId, xsecToken } = params ?? {};
    if (!noteId) return { ok: false, error: 'missing noteId' };

    try {
      const note = await loadNoteViaFetch(noteId, xsecToken);
      if (note) return { ok: true, note, via: 'fetch' };
    } catch {
      /* ignore */
    }

    try {
      const note = await loadNoteViaFrame(noteId, xsecToken);
      if (note) return { ok: true, note, via: 'iframe' };
    } catch {
      /* ignore */
    }

    return { ok: false, error: '无法获取笔记详情' };
  },
};

/**
 * 从 HTML 里抠出 __INITIAL_STATE__。
 *
 * 站点把它内联在 <script> 里，形如 `window.__INITIAL_STATE__={...}`。
 * 不能用正则去匹配对象（里面的字符串里可能有花括号），
 * 所以按括号配平扫描，跳过字符串字面量。
 */
function parseInitialState(html: string): any | null {
  const marker = 'window.__INITIAL_STATE__';
  const at = html.indexOf(marker);
  if (at < 0) return null;
  const eq = html.indexOf('=', at + marker.length);
  if (eq < 0) return null;
  const start = html.indexOf('{', eq);
  if (start < 0) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < html.length; i += 1) {
    const ch = html.charAt(i);
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '{') {
      depth += 1;
    } else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(html.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

/** 抓笔记页的 HTML，从里面解析出笔记详情 */
async function loadNoteViaFetch(noteId: string, xsecToken?: string): Promise<RawNote | null> {
  const url = `/explore/${encodeURIComponent(noteId)}${xsecToken ? `?xsec_token=${encodeURIComponent(xsecToken)}` : ''}`;
  const response = await fetch(url, { credentials: 'include' });
  if (!response.ok) return null;
  const html = await response.text();
  const state = parseInitialState(html);
  if (!state) return null;
  return extractNoteFromState(state, noteId);
}

/** 用隐藏 iframe 加载笔记页，读取它的 __INITIAL_STATE__ */
async function loadNoteViaFrame(noteId: string, xsecToken?: string): Promise<RawNote | null> {
  const url = `/explore/${encodeURIComponent(noteId)}${xsecToken ? `?xsec_token=${encodeURIComponent(xsecToken)}` : ''}`;
  const frame = document.createElement('iframe');
  frame.style.cssText =
    'position:fixed;left:-99999px;top:0;width:1280px;height:800px;border:0;visibility:hidden;';
  frame.src = url;
  document.body.appendChild(frame);

  try {
    // 笔记页是 SSR 的，状态内联在 HTML 里，实测 370ms 就能读到。
    // 轮询密一点省时间，超时给 8s —— 失败时别让用户干等十几秒。
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 80));
      let state: any = null;
      try {
        state = (frame.contentWindow as any)?.__INITIAL_STATE__;
      } catch {
        state = null;
      }
      if (state) {
        const note = extractNoteFromState(state, noteId);
        if (note) return note;
      }
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
