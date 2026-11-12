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
import https from 'node:https';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { notePageHtml } from './fake-site.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rn-e2e-ui-'));
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
    // 把下载目录指到临时目录：别往用户真实的「下载」文件夹里丢测试文件
    await cdp.send('Browser.setDownloadBehavior', {
      behavior: 'allow',
      downloadPath: downloadDir,
      eventsEnabled: false,
    });

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
