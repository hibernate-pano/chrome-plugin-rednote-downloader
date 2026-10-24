/**
 * ISOLATED world 侧的桥接客户端。
 * 通过 window.postMessage 与 MAIN world 的 page-hook 通信。
 */

const CHANNEL_ATTR = 'data-rednote-channel';
/** page-hook 在检测到 window.__INITIAL_STATE__ 后写入的标记 */
const STATE_ATTR = 'data-rednote-state';

interface PendingCall {
  resolve: (value: any) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface PageBridgeOptions {
  timeoutMs?: number;
}

export class PageBridge {
  private channel: string | null = null;
  private pending = new Map<string, PendingCall>();
  private seq = 0;
  private routeHandlers: Array<(path: string) => void> = [];
  private stateReadyHandlers: Array<() => void> = [];
  private stateReadyFired = false;
  private readyPromise: Promise<void> | null = null;
  private timeoutMs: number;

  constructor(options: PageBridgeOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? 15000;
    window.addEventListener('message', this.onMessage);
  }

  private onMessage = (event: MessageEvent): void => {
    if (event.source !== window) return;
    const data = event.data as any;
    if (!data || typeof data !== 'object') return;
    if (this.channel && data.__rednote !== this.channel) return;
    if (!this.channel) return;

    if (data.event === 'route' && typeof data.path === 'string') {
      for (const handler of this.routeHandlers) handler(data.path);
      return;
    }
    if (data.event === 'stateReady') {
      this.fireStateReady();
      return;
    }

    // window.postMessage 会把消息投递给同一个 window 上的所有监听器，
    // 所以这里会收到「自己刚发出去的请求」。只处理真正的响应，否则请求会被自己 reject。
    if (typeof data.id !== 'string') return;
    if (typeof data.method === 'string') return; // 这是我们发出的请求的回声
    if (typeof data.ok !== 'boolean') return;

    const pending = this.pending.get(data.id);
    if (!pending) return;
    this.pending.delete(data.id);
    clearTimeout(pending.timer);
    if (data.ok) pending.resolve(data.result);
    else pending.reject(new Error(data.error ?? '未知错误'));
  };

  /**
   * 站点的 __INITIAL_STATE__ 是页面脚本运行后才写入的。
   * 扩展的 content script 在 document_start 就跑完了，那时数据还不存在，
   * 所以必须等这个信号再识别内容。
   */
  onStateReady(handler: () => void): void {
    this.stateReadyHandlers.push(handler);
    void this.whenStateReady().then(() => this.fireStateReady());
  }

  private whenStateReady(): Promise<void> {
    const deadline = Date.now() + 30000;
    return new Promise<void>((resolve) => {
      const tick = () => {
        if (document.documentElement.getAttribute(STATE_ATTR) === '1') {
          resolve();
          return;
        }
        // 超时也要放行 —— 让上层走 DOM 兜底，而不是永远卡住
        if (Date.now() > deadline) {
          resolve();
          return;
        }
        setTimeout(tick, 100);
      };
      tick();
    });
  }

  private fireStateReady(): void {
    if (this.stateReadyFired) return;
    this.stateReadyFired = true;
    for (const handler of this.stateReadyHandlers) {
      try {
        handler();
      } catch {
        /* ignore */
      }
    }
  }

  /** 等待 MAIN world 就绪并拿到通道密钥 */
  ready(): Promise<void> {
    if (this.readyPromise) return this.readyPromise;
    this.readyPromise = new Promise<void>((resolve, reject) => {
      const deadline = Date.now() + 5000;
      const tick = () => {
        const channel = document.documentElement.getAttribute(CHANNEL_ATTR);
        if (channel) {
          this.channel = channel;
          resolve();
          return;
        }
        if (Date.now() > deadline) {
          reject(new Error('无法与页面脚本建立连接'));
          return;
        }
        setTimeout(tick, 50);
      };
      tick();
    });
    return this.readyPromise;
  }

  /**
   * 调用页面钩子。
   *
   * timeoutMs 可以单独放宽 —— 像「解析一条笔记」这种天然就慢的调用，
   * 用默认的 15s 会在它自己算好的预算用完之前就被砍掉。
   */
  async call<T = any>(method: string, params?: any, timeoutMs?: number): Promise<T> {
    await this.ready();
    const id = `c${++this.seq}`;
    const channel = this.channel!;

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`调用超时: ${method}`));
      }, timeoutMs ?? this.timeoutMs);

      this.pending.set(id, { resolve, reject, timer });
      window.postMessage({ __rednote: channel, id, method, params }, '*');
    });
  }

  /**
   * 等待站点数据（__INITIAL_STATE__）就绪。
   * 返回 true 表示已就绪；超时返回 false（调用方应走 DOM 兜底）。
   */
  async waitForStateReady(timeoutMs = 6000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (document.documentElement.getAttribute(STATE_ATTR) === '1') return true;
      if (Date.now() >= deadline) return false;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  /** 订阅 SPA 路由变化 */
  onRoute(handler: (path: string) => void): void {
    this.routeHandlers.push(handler);
    void this.call('__subscribeRoute').catch(() => undefined);
  }
}
