/**
 * 内容页 UI 的端到端测试：真实 Chrome + 本地假站点。
 *
 * 测的是「面板上肉眼能看到的东西」—— 这类问题单测测不了：
 * 进度刷不刷新、按钮点不点得到、取消入口在不在。
 *
 * 为什么自己起假站点：
 *   - 不碰用户的账号，也不需要网络；
 *   - 媒体直链指向本地，下载快慢、失败都可控 —— 取消功能要的就是「慢」。
 *
 * 假站点跑 https：扩展会把媒体地址里的 http 改成 https，
 * 本地 http 端口就取不到了。Chrome 用 --ignore-certificate-errors 放行。
 *
 * 运行：node build.mjs && node scripts/e2e-ui.mjs
 */
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import https from 'node:https';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { notePageHtml, serializeState } from './fake-site.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rednote-e2e-ui-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const CHROME_CANDIDATES = [
  `${process.env.HOME}/Library/Caches/ms-playwright/chromium-1248/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`,
  `${process.env.HOME}/Library/Caches/ms-playwright/chromium-1254/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`,
  `${process.env.HOME}/Library/Caches/ms-playwright/chromium-1194/chrome-mac/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
];

function resolveChrome() {
  for (const p of CHROME_CANDIDATES) if (fs.existsSync(p)) return p;
  throw new Error('找不到可用的 Chrome');
}

/* ------------------------------------------------------------------ */
/* 假数据                                                              */
/* ------------------------------------------------------------------ */

const AUTHOR = 'mockauthor';
const FAST_BYTES = 256 * 1024;
const SLOW_CHUNKS = 24;
const SLOW_CHUNK_BYTES = 64 * 1024;

/** 三条笔记：能下的、下不下来的（404）、慢吞吞的（用来测取消） */
const NOTES = [
  { id: 'mocknote0001', token: 'mock-token-fast', title: '能下的笔记', media: '/media/fast.mp4' },
  { id: 'mocknote0002', token: 'mock-token-broken', title: '下不下来的笔记', media: '/media/missing.mp4' },
  { id: 'mocknote0003', token: 'mock-token-slow', title: '慢吞吞的笔记', media: '/media/slow.mp4' },
];

function noteDetail(note, origin) {
  const url = `${origin}${note.media}`;
  return {
    noteId: note.id,
    type: 'video',
    title: note.title,
    desc: '这是假站点的测试数据',
    user: { nickname: AUTHOR, userId: 'mockuser0001' },
    interactInfo: { likedCount: 42 },
    video: {
      media: {
        stream: {
          h264: [
            {
              masterUrl: url,
              backupUrls: [url],
              duration: 1000,
              width: 720,
              height: 1280,
              size: FAST_BYTES,
              format: 'mp4',
            },
          ],
        },
      },
    },
  };
}

/** 主页的状态 —— 形状对齐真实的 user_posted 响应 */
function profileState() {
  return {
    user: {
      userPageData: { basicInfo: { nickname: AUTHOR } },
      notes: NOTES.map((n) => ({
        id: n.id,
        xsec_token: n.token,
        note_card: {
          display_title: n.title,
          type: 'video',
          cover: { url_default: '' },
          interact_info: { liked_count: 42 },
        },
      })),
    },
    note: { firstNoteId: NOTES[0].id, noteDetailMap: {}, currentNoteId: undefined },
  };
}

function profileHtml() {
  const cards = NOTES.map(
    (n) => `
      <section class="note-item">
        <a href="/explore/${n.id}?xsec_token=${n.token}">
          <img src="/media/fast.mp4" alt="" />
          <span class="title">${n.title}</span>
        </a>
      </section>`,
  ).join('');

  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<title>${AUTHOR} - 小红书</title>
<script>window.__INITIAL_STATE__ = ${serializeState(profileState())};</script>
</head><body><div id="app"><div class="feeds-container">${cards}</div></div></body></html>`;
}

/* ------------------------------------------------------------------ */
/* CDP                                                                 */
/* ------------------------------------------------------------------ */

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.listeners = [];
    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(JSON.stringify(msg.error)));
        else resolve(msg.result);
      }
      for (const fn of this.listeners) fn(msg);
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }
  on(fn) {
    this.listeners.push(fn);
  }
  async eval(expression) {
    const res = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (res.exceptionDetails) {
      throw new Error(res.exceptionDetails.exception?.description || 'evaluate 出错');
    }
    return res.result.value;
  }
}

async function connect(url) {
  const ws = new WebSocket(url);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });
  return new CDP(ws);
}

/* ------------------------------------------------------------------ */
/* 断言                                                                */
/* ------------------------------------------------------------------ */

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? '  ✅' : '  ❌'} ${name}${detail ? ` — ${detail}` : ''}`);
}

/* ------------------------------------------------------------------ */
/* 主流程                                                              */
/* ------------------------------------------------------------------ */

/** 把 Chrome 的下载目录指到测试目录（别写用户的 ~/Downloads） */
function prepareDownloadDir() {
  const dir = path.join(profileDir, 'downloads');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

async function main() {
  // 自签证书
  const key = path.join(profileDir, 'key.pem');
  const crt = path.join(profileDir, 'cert.pem');
  execFileSync(
    'openssl',
    [
      'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
      '-keyout', key, '-out', crt, '-days', '1', '-subj', '/CN=127.0.0.1',
    ],
    { stdio: 'ignore' },
  );
  const cert = { key: fs.readFileSync(key), cert: fs.readFileSync(crt) };

  const port = 9900 + (process.pid % 90);
  const origin = `https://127.0.0.1:${port}`;

  const server = https.createServer(cert, (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const p = url.pathname;
    // 扩展在后台页面里跨域取媒体，需要 CORS 头
    res.setHeader('access-control-allow-origin', '*');
    res.setHeader('access-control-expose-headers', 'Content-Length');

    if (p === '/media/fast.mp4') {
      res.setHeader('content-type', 'video/mp4');
      res.setHeader('content-length', String(FAST_BYTES));
      res.end(Buffer.alloc(FAST_BYTES, 7));
      return;
    }
    if (p === '/media/slow.mp4') {
      // 慢慢吐：取消功能要的就是「下载还在跑」的那一刻
      res.setHeader('content-type', 'video/mp4');
      res.setHeader('content-length', String(SLOW_CHUNKS * SLOW_CHUNK_BYTES));
      let sent = 0;
      const timer = setInterval(() => {
        sent += SLOW_CHUNK_BYTES;
        res.write(Buffer.alloc(SLOW_CHUNK_BYTES, 9));
        if (sent >= SLOW_CHUNKS * SLOW_CHUNK_BYTES) {
          clearInterval(timer);
          res.end();
        }
      }, 250);
      res.on('close', () => clearInterval(timer));
      return;
    }
    if (p === '/media/missing.mp4') {
      res.statusCode = 404;
      res.end('not found');
      return;
    }
    if (p.startsWith('/user/profile/')) {
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.end(profileHtml());
      return;
    }
    const explore = p.match(/^\/explore\/([A-Za-z0-9_-]+)/);
    if (explore) {
      const note = NOTES.find((n) => n.id === explore[1]);
      if (note) {
        res.setHeader('content-type', 'text/html; charset=utf-8');
        res.end(notePageHtml({ note, detail: noteDetail(note, origin) }));
        return;
      }
    }
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end('<!doctype html><html><body>ok</body></html>');
  });

  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  console.log(`▶ 假站点已启动：${origin}`);

  // 测试专用构建：复制一份 dist，给 content script 加上本地 origin 的匹配。
  // 交付用的 dist/ 完全不受影响。
  const testDist = path.join(profileDir, 'dist');
  fs.cpSync(dist, testDist, { recursive: true });
  const manifestPath = path.join(testDist, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  for (const cs of manifest.content_scripts) cs.matches.push(`${origin}/*`);
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

  prepareDownloadDir();
  const downloadDir = path.join(profileDir, 'downloads');

  const chrome = spawn(
    resolveChrome(),
    [
      `--user-data-dir=${profileDir}`,
      `--remote-debugging-port=${port + 500}`,
      `--disable-extensions-except=${testDist}`,
      `--load-extension=${testDist}`,
      '--ignore-certificate-errors',
      '--no-first-run',
      '--no-default-browser-check',
      '--window-size=1440,900',
      'about:blank',
    ],
    { stdio: 'ignore' },
  );

  const cleanup = () => {
    chrome.kill();
    server.close();
    if (process.env.KEEP_PROFILE) {
      console.log(`\n（保留了 profile 目录：${profileDir}）`);
      return;
    }
    try {
      fs.rmSync(profileDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  };

  try {
    await sleep(4000);
    const targets = await (await fetch(`http://127.0.0.1:${port + 500}/json/list`)).json();
    const page = targets.find((t) => t.type === 'page');
    if (!page) throw new Error('找不到页面 target');

    const cdp = await connect(page.webSocketDebuggerUrl);
    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');
    // 把页面拿到前台并让它认为自己是激活的：
    // 窗口在后台时 Chrome 会丢掉合成的鼠标按键事件（移动还在，按下没了），
    // hover 按钮那一段就永远点不动。
    await cdp.send('Page.bringToFront').catch(() => undefined);
    await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => undefined);
    // 把下载目录指到临时目录：别往用户真实的「下载」文件夹里丢测试文件
    await cdp.send('Browser.setDownloadBehavior', {
      behavior: 'allow',
      downloadPath: downloadDir,
      eventsEnabled: false,
    });

    // 连上 Service Worker：任务终态要到它自己的存储里核对，页面里看不到
    const hex = createHash('sha256').update(fs.realpathSync(testDist)).digest('hex').slice(0, 32);
    let extId = '';
    for (const c of hex) extId += String.fromCharCode(97 + parseInt(c, 16));
    let sw = null;
    for (let i = 0; i < 30 && !sw; i += 1) {
      const list = await (await fetch(`http://127.0.0.1:${port + 500}/json/list`)).json();
      const target = list.find(
        (t) => t.type === 'service_worker' && t.url.startsWith(`chrome-extension://${extId}/`),
      );
      if (target) {
        sw = await connect(target.webSocketDebuggerUrl);
        await sw.send('Runtime.enable');
        break;
      }
      await sleep(300);
    }

    const logs = [];
    cdp.on((msg) => {
      if (msg.method === 'Runtime.exceptionThrown') {
        logs.push({
          kind: 'exception',
          text: msg.params.exceptionDetails?.exception?.description || '',
          urls: [],
        });
      }
    });

    const evaluate = async (expression) => {
      const res = await cdp.send('Runtime.evaluate', {
        expression,
        awaitPromise: true,
        returnByValue: true,
      });
      if (res.exceptionDetails) {
        return { __EXC: res.exceptionDetails.exception?.description || 'exception' };
      }
      return res.result.value;
    };

    /** 等扩展注入并识别出内容 */
    const waitForRows = async (want = 1, tries = 60) => {
      for (let i = 0; i < tries; i += 1) {
        const n = await evaluate(
          `document.querySelector('rednote-root')?.shadowRoot?.querySelectorAll('.rn-row').length ?? 0`,
        );
        if (typeof n === 'number' && n >= want) return n;
        await sleep(400);
      }
      return 0;
    };

    /* ================================================================ */
    /* 问题 4：笔记页的进度、状态、重试按钮要能刷新                       */
    /* ================================================================ */
    console.log('\n▶ 问题 4：笔记页进度刷新');

    await cdp.send('Page.navigate', { url: `${origin}/explore/mocknote0001` });
    const rows = await waitForRows(1);
    check('笔记页识别出资源', rows >= 1, `rows=${rows}`);

    await evaluate(`
      (() => {
        const sr = document.querySelector('rednote-root').shadowRoot;
        sr.querySelector('.rn-fab').click();
        return true;
      })()
    `);
    await sleep(600);

    const before = await evaluate(`
      (() => {
        const sr = document.querySelector('rednote-root').shadowRoot;
        const row = sr.querySelector('.rn-row');
        return {
          state: row?.dataset.state ?? null,
          meta: row?.querySelector('.rn-row-meta')?.textContent || '',
          footer: sr.querySelector('.rn-footer-title')?.textContent || '',
        };
      })()
    `);
    check(
      '下载前行上还没有状态',
      before.state === null,
      `state=${before.state} meta=${JSON.stringify(before.meta)}`,
    );

    // 记下这一页弹过的所有提示：提示自己会消失，事后数 DOM 里剩几条会漏
    await evaluate(`
      (() => {
        window.__toastLog = [];
        const sr = document.querySelector('rednote-root').shadowRoot;
        const box = sr.querySelector('.rn-toasts');
        if (!box) return false;
        new MutationObserver((muts) => {
          for (const m of muts) {
            for (const node of m.addedNodes) {
              if (node.nodeType === 1) window.__toastLog.push(node.textContent || '');
            }
          }
        }).observe(box, { childList: true });
        return true;
      })()
    `);

    // 点这一行的下载按钮
    await evaluate(`
      (() => {
        const sr = document.querySelector('rednote-root').shadowRoot;
        const btn = sr.querySelector('.rn-row .rn-btn');
        btn.click();
        return true;
      })()
    `);

    // 等这一行进入终态
    let rowState = null;
    for (let i = 0; i < 60; i += 1) {
      rowState = await evaluate(`
        (() => {
          const sr = document.querySelector('rednote-root').shadowRoot;
          const row = sr.querySelector('.rn-row');
          return {
            state: row?.dataset.state ?? null,
            meta: row?.querySelector('.rn-row-meta')?.textContent || '',
            pct: row?.querySelector('.rn-row-pct')?.textContent || null,
            footer: sr.querySelector('.rn-footer-title')?.textContent || '',
            footerSub: sr.querySelector('.rn-footer-sub')?.textContent || '',
          };
        })()
      `);
      if (rowState?.state === 'completed' || rowState?.state === 'failed') break;
      await sleep(300);
    }
    check(
      '笔记页的行状态跟着下载刷新（不是一直空着）',
      rowState?.state === 'completed',
      `state=${rowState?.state} meta=${JSON.stringify(rowState?.meta)} footer=${JSON.stringify(rowState?.footer)}`,
    );
    check(
      '完成后行上写着「已保存」',
      /已保存/.test(rowState?.meta || ''),
      `meta=${JSON.stringify(rowState?.meta)}`,
    );
    check(
      '底部汇总也跟着刷新',
      /已完成\s*1/.test(rowState?.footerSub || ''),
      `footer=${JSON.stringify(rowState?.footer)} sub=${JSON.stringify(rowState?.footerSub)}`,
    );

    const toastLog = await evaluate('JSON.stringify(window.__toastLog || [])');
    let pageToasts = [];
    try {
      pageToasts = JSON.parse(String(toastLog));
    } catch {
      /* ignore */
    }
    check(
      '完成提示只弹一次',
      pageToasts.filter((t) => /已保存/.test(String(t))).length === 1,
      `toasts=${String(toastLog)}`,
    );

    /* 失败的那条：要能看到失败，并且有重试按钮 */
    await cdp.send('Page.navigate', { url: `${origin}/explore/mocknote0002` });
    await waitForRows(1);
    await evaluate(`
      (() => {
        const sr = document.querySelector('rednote-root').shadowRoot;
        sr.querySelector('.rn-fab').click();
        return true;
      })()
    `);
    await sleep(600);
    await evaluate(`
      (() => {
        const sr = document.querySelector('rednote-root').shadowRoot;
        sr.querySelector('.rn-row .rn-btn').click();
        return true;
      })()
    `);

    let failState = null;
    for (let i = 0; i < 80; i += 1) {
      failState = await evaluate(`
        (() => {
          const sr = document.querySelector('rednote-root').shadowRoot;
          const row = sr.querySelector('.rn-row');
          const action = row?.querySelector('.rn-row-action');
          return {
            state: row?.dataset.state ?? null,
            meta: row?.querySelector('.rn-row-meta')?.textContent || '',
            action: (action?.textContent || '').trim(),
          };
        })()
      `);
      if (failState?.state === 'failed' || failState?.state === 'completed') break;
      await sleep(400);
    }
    check(
      '下失败的条目状态是 failed',
      failState?.state === 'failed',
      `state=${failState?.state} meta=${JSON.stringify(failState?.meta)}`,
    );
    check(
      '失败条目有重试按钮',
      /重试/.test(failState?.action || ''),
      `action=${JSON.stringify(failState?.action)}`,
    );

    /* ================================================================ */
    /* 折叠切换不能把 null 传进 renderNote                                */
    /* ================================================================ */
    const collapse = await evaluate(`
      (() => {
        const sr = document.querySelector('rednote-root').shadowRoot;
        const head = sr.querySelector('.rn-section-head');
        if (!head) return { ok: false, why: '没有分组标题' };
        head.click();
        const afterFirst = {
          rows: sr.querySelectorAll('.rn-row').length,
          head: head.textContent.trim(),
        };
        head.click();
        return { ok: true, afterFirst, rowsBack: sr.querySelectorAll('.rn-row').length };
      })()
    `);
    check(
      '折叠/展开不炸，行还在',
      collapse?.ok && collapse?.rowsBack >= 1,
      JSON.stringify(collapse),
    );

    /* ================================================================ */
    /* 问题 6：下载中要有取消入口，取消后任务落到终态                     */
    /* ================================================================ */
    console.log('\n▶ 问题 6：取消下载');

    await cdp.send('Page.navigate', { url: `${origin}/explore/mocknote0003` });
    await waitForRows(1);
    await evaluate(`
      (() => {
        const sr = document.querySelector('rednote-root').shadowRoot;
        sr.querySelector('.rn-fab').click();
        return true;
      })()
    `);
    await sleep(600);
    await evaluate(`
      (() => {
        const sr = document.querySelector('rednote-root').shadowRoot;
        sr.querySelector('.rn-row .rn-btn').click();
        return true;
      })()
    `);

    // 等它真的开始下载（慢速媒体，能稳定停在 downloading）
    let during = null;
    for (let i = 0; i < 40; i += 1) {
      during = await evaluate(`
        (() => {
          const sr = document.querySelector('rednote-root').shadowRoot;
          const row = sr.querySelector('.rn-row');
          return {
            state: row?.dataset.state ?? null,
            cancel: [...sr.querySelectorAll('.rn-footer .rn-btn')]
              .map((b) => b.textContent.trim())
              .find((t) => t === '取消') ?? null,
          };
        })()
      `);
      if (during?.state === 'downloading' && during?.cancel) break;
      await sleep(200);
    }
    check('下载中行状态是 downloading', during?.state === 'downloading', `state=${during?.state}`);
    check('下载中面板上有「取消」按钮', during?.cancel === '取消', `buttons=${JSON.stringify(during)}`);

    // 点取消
    await evaluate(`
      (() => {
        const sr = document.querySelector('rednote-root').shadowRoot;
        const btn = [...sr.querySelectorAll('.rn-footer .rn-btn')]
          .find((b) => b.textContent.trim() === '取消');
        if (!btn) throw new Error('找不到取消按钮');
        btn.click();
        return true;
      })()
    `);

    let afterCancel = null;
    for (let i = 0; i < 40; i += 1) {
      afterCancel = await evaluate(`
        (() => {
          const sr = document.querySelector('rednote-root').shadowRoot;
          const row = sr.querySelector('.rn-row');
          return {
            state: row?.dataset.state ?? null,
            meta: row?.querySelector('.rn-row-meta')?.textContent || '',
            action: (row?.querySelector('.rn-row-action')?.textContent || '').trim(),
            footer: sr.querySelector('.rn-footer-title')?.textContent || '',
            cancel: [...sr.querySelectorAll('.rn-footer .rn-btn')]
              .some((b) => b.textContent.trim() === '取消'),
          };
        })()
      `);
      if (afterCancel?.state === 'cancelled') break;
      await sleep(250);
    }
    check(
      '取消后行落到 cancelled（不是一直 downloading）',
      afterCancel?.state === 'cancelled',
      `state=${afterCancel?.state} meta=${JSON.stringify(afterCancel?.meta)}`,
    );
    check('取消后行上写「已取消」', /已取消/.test(afterCancel?.meta || ''), `meta=${JSON.stringify(afterCancel?.meta)}`);
    check(
      '取消后不再显示取消按钮（任务已经收尾）',
      afterCancel?.cancel === false,
      `footer=${JSON.stringify(afterCancel?.footer)}`,
    );
    check('取消后可以重试（不是死路）', /重试/.test(afterCancel?.action || ''), `action=${JSON.stringify(afterCancel?.action)}`);

    // 取消不该被当成「跑完了」：一个都没存下来，就不能弹出「已保存 0 个文件」
    await sleep(500);
    const cancelToast = await evaluate(`
      [...document.querySelector('rednote-root')?.shadowRoot?.querySelectorAll('.rn-toast') ?? []]
        .map((t) => t.textContent).join(' | ')
    `);
    check(
      '取消后不报「已保存 0 个文件」',
      !/已保存\s*0\s*个/.test(String(cancelToast)),
      `toasts=${JSON.stringify(cancelToast)}`,
    );

    /* 任务真的收尾了：Service Worker 里的快照要有 finishedAt */
    if (sw) {
      const snapshot = await sw
        .eval(`
          (async () => {
            const raw = await chrome.storage.session.get('rednote.download.tasks');
            const list = raw['rednote.download.tasks'] || [];
            const t = list[list.length - 1];
            return JSON.stringify({
              states: (t?.items || []).map((i) => i.state),
              finishedAt: t?.summary?.finishedAt ?? null,
            });
          })()
        `)
        .catch(() => '');
      let parsed = {};
      try {
        parsed = JSON.parse(String(snapshot));
      } catch {
        /* ignore */
      }
      check(
        '取消后任务写上了終态时间（finishedAt）',
        Boolean(parsed.finishedAt),
        `snapshot=${String(snapshot)}`,
      );
    } else {
      check('取消后任务写上了終态时间（finishedAt）', false, '没连上 Service Worker');
    }

    /* ================================================================ */
    /* 问题 5：主页 hover 出来的快捷下载按钮要能点                        */
    /* ================================================================ */
    console.log('\n▶ 问题 5：主页 hover 快捷下载按钮');

    await cdp.send('Page.navigate', { url: `${origin}/user/profile/mockuser0001` });
    await sleep(2500);

    let injected = false;
    for (let i = 0; i < 40; i += 1) {
      injected = await evaluate(
        `!!document.querySelector('rednote-root')?.shadowRoot?.querySelector('.rn-hover-btn')`,
      );
      if (injected) break;
      await sleep(400);
    }
    check('主页上装好了 hover 快捷下载按钮', Boolean(injected));

    // 关掉 UI 的过渡动画：这是在测「按钮能不能点」，不是在测动画。
    // 自动化窗口可能在后台，合成器不出新帧，动画会停在 .85 缩放上，
    // 鼠标事件打在上一帧的图上就会点空 —— 跟按钮本身能不能点没关系。
    await evaluate(`
      (() => {
        const sr = document.querySelector('rednote-root')?.shadowRoot;
        if (!sr || sr.querySelector('style#e2e-no-anim')) return false;
        const st = document.createElement('style');
        st.id = 'e2e-no-anim';
        st.textContent = '.rn-hover-btn { transition: none !important; animation: none !important; }';
        sr.appendChild(st);
        return true;
      })()
    `);

    const hoverState = () =>
      evaluate(`
        (() => {
          const sr = document.querySelector('rednote-root')?.shadowRoot;
          const btn = sr?.querySelector('.rn-hover-btn');
          if (!btn) return { show: null, rect: null };
          const r = btn.getBoundingClientRect();
          return {
            show: btn.dataset.show,
            rect: { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height },
          };
        })()
      `);

    // 鼠标移到第一张卡片上 → 按钮冒出来
    const card = await evaluate(`
      (() => {
        const c = document.querySelector('section.note-item');
        if (!c) return null;
        const r = c.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      })()
    `);
    check('主页上有笔记卡片', Boolean(card), JSON.stringify(card));

    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: card.x,
      y: card.y,
      button: 'none',
    });
    await sleep(400);
    const onCard = await hoverState();
    check('鼠标停在卡片上时按钮出现', onCard?.show === 'true', `data-show=${onCard?.show}`);

    // 鼠标从卡片移到按钮上 → 按钮不能消失（这是修好之前点不到的原因）
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: onCard.rect.x,
      y: onCard.rect.y,
      button: 'none',
    });
    await sleep(400);
    const onButton = await hoverState();
    check(
      '鼠标移到按钮上时按钮不消失',
      onButton?.show === 'true',
      `data-show=${onButton?.show} rect=${JSON.stringify(onButton?.rect)}`,
    );

    // 点它 → 得有反应
    //
    // 光看 data-show 不够：按钮还得真的能接住鼠标。
    // 先等缩放动画跑完（.85 缩放时宽度只有 23.8px）：动画没跑完就点，
    // 命中测试可能还打在上一次「还藏着」的那一帧上。
    let settledRect = onButton?.rect ?? null;
    for (let i = 0; i < 30; i += 1) {
      settledRect = (await hoverState())?.rect ?? settledRect;
      if (settledRect && settledRect.w >= 27.5) break;
      await sleep(100);
    }
    const hit = await evaluate(`
      (() => {
        const sr = document.querySelector('rednote-root')?.shadowRoot;
        const btn = sr?.querySelector('.rn-hover-btn');
        if (!btn) return { pe: null, isBtn: false };
        const r = btn.getBoundingClientRect();
        // 从 shadow root 里测，才看得到 shadow 内部真正接住鼠标的是谁。
        // 正中间是按钮里的图标，所以命中结果可能是它的子元素 —— 落在按钮里就算数。
        const top = sr.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        return { pe: getComputedStyle(btn).pointerEvents, isBtn: Boolean(top && (top === btn || btn.contains(top))) };
      })()
    `);
    check(
      '按钮能接住鼠标（pointer-events + 命中测试）',
      hit.pe === 'auto' && hit.isBtn === true,
      `pointer-events=${hit.pe} 命中按钮=${hit.isBtn}`,
    );

    const toastsBefore = await evaluate(`
      document.querySelector('rednote-root')?.shadowRoot?.querySelectorAll('.rn-toast').length ?? 0
    `);
    // 按「按钮此刻的位置」点：真人也是看着当前的位置点的。
    // 用几帧之前量到的坐标会因为缩放动画/布局微调点空。
    const clickAt = (await hoverState())?.rect ?? settledRect ?? onButton.rect;
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: clickAt.x,
      y: clickAt.y,
      button: 'none',
    });
    await sleep(80);
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x: clickAt.x,
      y: clickAt.y,
      button: 'left',
      buttons: 1,
      clickCount: 1,
    });
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x: clickAt.x,
      y: clickAt.y,
      button: 'left',
      buttons: 0,
      clickCount: 1,
    });
    // 点击处理的第一步就是 hide()：按钮被藏了说明事件确实送到了它手上。
    // 光看「有没有新提示」分不清「没点到」和「点到了但后面出错」。
    await sleep(150);
    const hiddenAfterClick = await evaluate(`
      document.querySelector('rednote-root')?.shadowRoot?.querySelector('.rn-hover-btn')?.dataset.show ?? null
    `);
    check('点击事件送达到了按钮（按钮随即收起）', hiddenAfterClick === 'false', `data-show=${hiddenAfterClick}`);


    // 提示有时限（成功提示 3.2s 后自动消失），只等一次容易正好错过 ——
    // 每 200ms 看一次，看到新提示就收工。
    let toast = '';
    for (let i = 0; i < 40; i += 1) {
      await sleep(200);
      toast = await evaluate(`
        [...document.querySelector('rednote-root')?.shadowRoot?.querySelectorAll('.rn-toast') ?? []]
          .map((t) => t.textContent).join(' | ')
      `);
      if (String(toast).trim()) break;
    }
    const toastsAfter = await evaluate(`
      document.querySelector('rednote-root')?.shadowRoot?.querySelectorAll('.rn-toast').length ?? 0
    `);
    check(
      '点按钮真的触发了下载（出现新的提示）',
      toastsAfter > toastsBefore && /已保存|已开始|解析|下载/.test(String(toast)),
      `before=${toastsBefore} after=${toastsAfter} toast=${String(toast)}`,
    );
    check(
      '完成提示只弹一次（主页快捷下载）',
      String(toast).split(' | ').filter((t) => /已保存/.test(t)).length === 1,
      `toast=${String(toast)}`,
    );
  } finally {
    cleanup();
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n═══ 结果：${results.length - failed.length}/${results.length} 通过 ═══`);
  if (failed.length) {
    for (const f of failed) console.log(`  ❌ ${f.name} — ${f.detail}`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error('测试失败:', err);
  process.exitCode = 1;
});
