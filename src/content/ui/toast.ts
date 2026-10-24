import { icon } from './icons';

export type ToastTone = 'info' | 'success' | 'error' | 'warning';

export interface ToastOptions {
  title: string;
  body?: string;
  tone?: ToastTone;
  /** 毫秒；0 表示不自动消失 */
  duration?: number;
  action?: { label: string; onClick: () => void };
}

const MAX_TOASTS = 3;

export class ToastManager {
  private container: HTMLElement | null = null;

  mount(root: ShadowRoot): void {
    const el = document.createElement('div');
    el.className = 'rn-toasts';
    el.setAttribute('role', 'status');
    el.setAttribute('aria-live', 'polite');
    root.appendChild(el);
    this.container = el;
  }

  show(options: ToastOptions): void {
    if (!this.container) return;

    while (this.container.children.length >= MAX_TOASTS) {
      this.container.firstElementChild?.remove();
    }

    const tone = options.tone ?? 'info';
    const duration = options.duration ?? (tone === 'error' || tone === 'warning' ? 0 : 3200);

    const el = document.createElement('div');
    el.className = 'rn-toast';
    el.dataset.tone = tone;
    if (tone === 'error') el.setAttribute('role', 'alert');

    const title = document.createElement('div');
    title.className = 'rn-toast-title';
    title.textContent = options.title;
    el.appendChild(title);

    if (options.body) {
      const body = document.createElement('div');
      body.className = 'rn-toast-body';
      body.textContent = options.body;
      el.appendChild(body);
    }

    if (options.action) {
      const action = document.createElement('button');
      action.className = 'rn-toast-action';
      action.type = 'button';
      action.textContent = options.action.label;
      action.addEventListener('click', () => {
        options.action?.onClick();
        el.remove();
      });
      el.appendChild(action);
    }

    const close = document.createElement('button');
    close.className = 'rn-toast-close';
    close.type = 'button';
    close.setAttribute('aria-label', '关闭提示');
    close.innerHTML = icon('close', 13);
    close.addEventListener('click', () => el.remove());
    el.appendChild(close);

    this.container.appendChild(el);

    if (duration > 0) {
      setTimeout(() => {
        el.style.transition = 'opacity .14s ease';
        el.style.opacity = '0';
        setTimeout(() => el.remove(), 160);
      }, duration);
    }
  }

  error(title: string, body?: string, action?: ToastOptions['action']): void {
    this.show({ title, body, tone: 'error', action });
  }

  success(title: string, body?: string): void {
    this.show({ title, body, tone: 'success' });
  }

  info(title: string, body?: string): void {
    this.show({ title, body, tone: 'info' });
  }
}
