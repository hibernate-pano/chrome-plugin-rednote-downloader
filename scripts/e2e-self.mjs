/**
 * 自研下载引擎的端到端测试。
 *
 * 用法：node scripts/e2e-self.mjs
 * 前置：npm run build
 *
 * 测的是「扩展自己取字节、自己写文件」这条主路径：
 *   1. 没设保存目录时，任务会挂起并弹出选目录窗口
 *   2. 目录就绪后文件真的落盘了，目录结构跟「按笔记建文件夹」一致
 *   3. **浏览器里一条下载记录都没有** —— 这正是换掉 chrome.downloads 的意义
 *   4. 进度是精确的字节数，不是估算
 *
 * 「用户选的文件夹」在这里用 OPFS 顶替：
 * 选目录窗口必须由用户手势触发，系统对话框没法自动化；
 * 但句柄从 IndexedDB 读出来之后，Service Worker 写文件走的是同一套 API。
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');

const CHROME_CANDIDATES = [
  path.join(
    process.env.HOME ?? '',
    'Library/Caches/ms-playwright/chromium-1248/chrome-mac-arm64',
    'Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
  ),
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
];
function resolveChrome() {
  for (const p of CHROME_CANDIDATES) if (fs.existsSync(p)) return p;
  throw new Error('找不到可用的 Chrome');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ */
/* 假数据                                                              */
/* ------------------------------------------------------------------ */

const IMAGE_FILE_ID = '1040g2sg325d5f1ni4q005n341tr4na22ndh5mg8';
const IMAGE_PREVIEW =
  'https://sns-webpic-qc.xhscdn.com/202610241249/036c3b98f180befdb20ada1f779c0111/' +
  IMAGE_FILE_ID +
  '!nd_dft_wlteh_webp_3';
const VIDEO_URL =
  'https://sns-bak-v1.xhscdn.com/stream/79/110/258/01eab1a3bcc06cc24f037001a0c5e9440a_258.mp4';

const AUTHOR = 'selfauthor';

const NOTES = [
  {
    id: 'selfnote0001',
    token: 'self-token-video',
    type: 'video',
    title: '视频笔记',
    images: [{ fileId: IMAGE_FILE_ID, width: 1440, height: 1921 }],
    video: {
      masterUrl: `${VIDEO_URL}?sign=mock&t=1`,
      backupUrls: [VIDEO_URL],
      duration: 21733,
      width: 720,
      height: 1280,
      size: 11366919,
      format: 'mp4',
    },
  },
  {
    id: 'selfnote0002',
    token: 'self-token-photo',
    type: 'normal',
    title: '图集笔记一',
    images: [{ fileId: IMAGE_FILE_ID, width: 1440, height: 1921 }],
  },
];

function noteDetail(note) {
  return {
    noteId: note.id,
    type: note.type,
    title: note.title,
    desc: '这是假站点的测试数据',
    user: { nickname: AUTHOR, userId: 'selfuser0001' },
    interactInfo: { likedCount: 42 },
    imageList: note.images.map((img) => ({
      fileId: img.fileId,
      width: img.width,
      height: img.height,
      urlDefault: IMAGE_PREVIEW,
      url: '',
      infoList: [{ imageScene: 'WB_DFT', url: IMAGE_PREVIEW }],
    })),
    ...(note.video ? { video: { media: { stream: { h264: [note.video] } } } } : {}),
  };
}

function profileState() {
  return {
    user: {
      userPageData: { basicInfo: { nickname: AUTHOR } },
      notes: NOTES.map((n) => ({
        id: n.id,
        xsec_token: n.token,
        note_card: {
          display_title: n.title,
          type: n.type === 'video' ? 'video' : 'normal',
          cover: { url_default: IMAGE_PREVIEW },
          interact_info: { liked_count: 42 },
        },
      })),
    },
    note: { firstNoteId: NOTES[0].id, noteDetailMap: {} },
  };
}

function profileHtml() {
  const cards = NOTES.map(
    (n) => `
      <section class="note-item">
        <a href="/explore/${n.id}?xsec_token=${n.token}">
          <img src="${IMAGE_PREVIEW}" alt="" />
          <span class="title">${n.title}</span>
        </a>
      </section>`,
  ).join('');

  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<title>${AUTHOR} - 小红书</title>
<script>window.__INITIAL_STATE__ = ${JSON.stringify(profileState())};</script>
</head><body><div id="app"><div class="feeds-container">${cards}</div></div></body></html>`;
}

function noteHtml(note) {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<title>${note.title} - 小红书</title>
<script>window.__INITIAL_STATE__ = ${JSON.stringify({
    note: { firstNoteId: note.id, noteDetailMap: { [note.id]: { note: noteDetail(note) } } },
  })};</script></head><body><div id="app"></div></body></html>`;
}

/* ------------------------------------------------------------------ */
/* CDP                                                                 */
/* ------------------------------------------------------------------ */

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(JSON.stringify(msg.error)));
        else resolve(msg.result);
      }
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP 超时: ${method}`));
        }
      }, 60000);
    });
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
/* 测试主体                                                            */
/* ------------------------------------------------------------------ */

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? '  ✅' : '  ❌'} ${name}${detail ? ` — ${detail}` : ''}`);
}

const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rn-e2e-self-'));
const testDist = path.join(profileDir, 'dist');
let chrome;
let sw = null;
let extId = '';

async function findServiceWorker(port) {
  for (let i = 0; i < 40; i += 1) {
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    const target = targets.find(
      (t) => t.type === 'service_worker' && t.url.startsWith(`chrome-extension://${extId}/`),
    );
    if (target) return target;
    await sleep(300);
  }
  throw new Error('找不到 Service Worker target');
}

/** 列出 OPFS 里的所有文件（相对路径 + 字节数） */
const listOpfs = `
  (async () => {
    const root = await navigator.storage.getDirectory();
    const out = [];
    async function walk(dir, prefix) {
      for await (const [name, handle] of dir.entries()) {
        const path = prefix ? prefix + '/' + name : name;
        if (handle.kind === 'directory') await walk(handle, path);
        else {
          const file = await handle.getFile();
          out.push({ path, size: file.size });
        }
      }
    }
    await walk(root, '');
    return JSON.stringify(out);
  })()
`;

/** 浏览器里现在有多少条下载记录 */
const countDownloads = `
  (async () => {
    const list = await chrome.downloads.search({});
    return JSON.stringify(list.map((d) => d.filename));
  })()
`;

async function main() {
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    res.setHeader('content-type', 'text/html; charset=utf-8');
    if (url.pathname.startsWith('/user/profile/')) return void res.end(profileHtml());
    const explore = url.pathname.match(/^\/explore\/([A-Za-z0-9_-]+)/);
    if (explore) {
      const note = NOTES.find((n) => n.id === explore[1]);
      if (note) return void res.end(noteHtml(note));
    }
    res.end('<!doctype html><html><body>ok</body></html>');
  });

  const port = 9900 + (process.pid % 90);
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${port}`;
  console.log(`▶ 假站点：http://127.0.0.1:${port}`);

  fs.cpSync(dist, testDist, { recursive: true });
  const manifestPath = path.join(testDist, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  for (const cs of manifest.content_scripts) cs.matches.push(`${origin}/*`);
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

  const hex = createHash('sha256').update(fs.realpathSync(testDist)).digest('hex').slice(0, 32);
  for (const c of hex) extId += String.fromCharCode(97 + parseInt(c, 16));

  chrome = spawn(
    resolveChrome(),
    [
      `--user-data-dir=${profileDir}`,
      `--remote-debugging-port=${port + 500}`,
      `--disable-extensions-except=${testDist}`,
      `--load-extension=${testDist}`,
      '--no-first-run',
      '--no-default-browser-check',
      'about:blank',
    ],
    { stdio: 'ignore' },
  );

  const cleanup = () => {
    try {
      chrome?.kill();
    } catch {
      /* ignore */
    }
    server.close();
    try {
      fs.rmSync(profileDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  };
  process.on('exit', cleanup);

  await sleep(4000);
  const swTarget = await findServiceWorker(port + 500);
  sw = await connect(swTarget.webSocketDebuggerUrl);
  await sw.send('Runtime.enable');

  const list = await (await fetch(`http://127.0.0.1:${port + 500}/json/list`)).json();
  const page = list.find((t) => t.type === 'page');
  const cdp = await connect(page.webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');

  /* ---------------------------------------------------------------- */
  /* 1. 没设目录时，任务挂起并弹选目录窗口                            */
  /* ---------------------------------------------------------------- */
  console.log('\n▶ 没设保存目录时点下载…');
  await cdp.send('Page.navigate', { url: `${origin}/user/profile/selfuser0001` });
  await sleep(2500);

  const injected = await cdp.eval(
    `!!document.querySelector('rednote-root')?.shadowRoot?.querySelector('.rn-panel')`,
  );
  check('扩展已注入主页', injected === true, String(injected));

  // 打开面板 → 等扫描出卡片
  await cdp.eval(`
    (() => {
      const sr = document.querySelector('rednote-root').shadowRoot;
      sr.querySelector('.rn-fab').click();
      return true;
    })()
  `);

  let cardCount = 0;
  for (let i = 0; i < 40; i += 1) {
    await sleep(600);
    cardCount = await cdp.eval(
      `document.querySelector('rednote-root').shadowRoot.querySelectorAll('.rn-card').length`,
    );
    if (cardCount > 0) break;
  }
  check('主页扫描出卡片', cardCount === 2, `cards=${cardCount}`);

  // 全选并点开始下载
  await cdp.eval(`
    (() => {
      const sr = document.querySelector('rednote-root').shadowRoot;
      const all = [...sr.querySelectorAll('.rn-toolbar-right .rn-btn')].find(b => /全选/.test(b.textContent));
      if (all) all.click();
      return true;
    })()
  `);
  await sleep(500);
  await cdp.eval(`
    (() => {
      const sr = document.querySelector('rednote-root').shadowRoot;
      const start = sr.querySelector('.rn-footer .rn-btn[data-variant="primary"]');
      if (!start) throw new Error('找不到开始下载按钮');
      start.click();
      return true;
    })()
  `);
  await sleep(3000);

  const waiting = await cdp.eval(`
    (() => {
      const sr = document.querySelector('rednote-root').shadowRoot;
      const body = sr.querySelector('.rn-body')?.textContent || '';
      const footer = sr.querySelector('.rn-footer-sub')?.textContent || '';
      return JSON.stringify({ body: body.slice(0, 400), footer });
    })()
  `);
  check(
    '没设目录时任务挂起，界面说清楚在等什么',
    /选目录|保存目录/.test(waiting),
    waiting,
  );

  const pendingTask = await sw.eval(`
    (async () => {
      const raw = await chrome.storage.session.get('rednote.download.tasks');
      const list = raw['rednote.download.tasks'] || [];
      return JSON.stringify(list.map(t => ({ engine: t.engine, waiting: t.waiting, states: t.items.map(i => i.state) })));
    })()
  `);
  check(
    '任务处于等待目录的状态',
    /"waiting":true/.test(pendingTask) && /"waiting"/.test(pendingTask),
    pendingTask,
  );

  const pickerOpened = await (async () => {
    const targets = await (await fetch(`http://127.0.0.1:${port + 500}/json/list`)).json();
    return targets.some((t) => t.url.includes('picker.html'));
  })();
  check('选目录窗口已弹出', pickerOpened === true, String(pickerOpened));

  /* ---------------------------------------------------------------- */
  /* 2. 目录就绪后，文件真的落盘了                                     */
  /* ---------------------------------------------------------------- */
  console.log('\n▶ 选好目录后继续下载…');
  // 句柄必须由扩展自己的页面写进 IndexedDB，Service Worker 才能读到。
  // 这里借已经弹出来的选目录窗口来干这件事（它就是扩展页面）。
  const pickerTarget = (await (await fetch(`http://127.0.0.1:${port + 500}/json/list`)).json()).find(
    (t) => t.type === 'page' && t.url.includes('picker.html'),
  );
  if (!pickerTarget) throw new Error('找不到选目录窗口');
  const picker = await connect(pickerTarget.webSocketDebuggerUrl);
  await picker.send('Runtime.enable');
  await picker.eval(`
    (async () => {
      const root = await navigator.storage.getDirectory();
      // 用一个子目录当「用户选的文件夹」：根目录没有名字，不够像
      const dir = await root.getDirectoryHandle('测试目录', { create: true });
      const db = await new Promise((resolve, reject) => {
        const req = indexedDB.open('rednote-fs', 1);
        req.onupgradeneeded = () => {
          if (!req.result.objectStoreNames.contains('handles')) {
            req.result.createObjectStore('handles');
          }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      await new Promise((resolve, reject) => {
        const tx = db.transaction('handles', 'readwrite');
        tx.objectStore('handles').put(dir, 'root');
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
      });
      await chrome.runtime.sendMessage({ type: 'DIRECTORY_READY', name: '测试目录' });
      return 'ok';
    })()
  `);

  // 等这个任务真的跑完 —— 不能只等「文件数量够了」：
  // 下载中的文件也会占名额（临时文件 + 提交机制），
  // 早一步断言就会读到还没下完的中间状态。
  let files = [];
  let finished = false;
  for (let i = 0; i < 120; i += 1) {
    await sleep(500);
    const state = JSON.parse(
      await sw.eval(`
        (async () => {
          const raw = await chrome.storage.session.get('rednote.download.tasks');
          const list = raw['rednote.download.tasks'] || [];
          const t = list.pop();
          return JSON.stringify({
            finished: Boolean(t?.summary?.finishedAt),
            states: (t?.items || []).map(i => i.state),
          });
        })()
      `),
    );
    files = JSON.parse(await sw.eval(listOpfs));
    if (state.finished) {
      finished = true;
      break;
    }
  }
  check('三个文件都下载完了', finished, JSON.stringify(files));
  check('文件真的落盘了', files.length >= 3, JSON.stringify(files));
  // 下载过程中写的是 .crdownload 临时文件，下完改名 —— 目录里不该有残留
  check(
    '目录里没有临时文件残留',
    files.every((f) => !/\.cr(download|swap)$/i.test(f.path)),
    files.map((f) => f.path).join(' | '),
  );

  const paths = files.map((f) => f.path);
  check(
    '目录结构是「按笔记建文件夹」',
    paths.some((p) => p.includes('视频笔记/')) && paths.some((p) => p.includes('图集笔记一/')),
    paths.join(' | '),
  );
  check(
    '文件带扩展名且非空',
    files.every((f) => /\.(mp4|jpg|jpeg|png|webp)$/i.test(f.path) && f.size > 1024),
    files.map((f) => `${f.path}=${f.size}B`).join(' | '),
  );

  /* ---------------------------------------------------------------- */
  /* 3. 浏览器里一条下载记录都没有                                      */
  /* ---------------------------------------------------------------- */
  const downloads = JSON.parse(await sw.eval(countDownloads));
  check(
    '浏览器里没有留下任何下载记录',
    downloads.length === 0,
    `downloads=${JSON.stringify(downloads)}`,
  );

  /* ---------------------------------------------------------------- */
  /* 4. 进度是精确的字节数                                             */
  /* ---------------------------------------------------------------- */
  const progress = await sw.eval(`
    (async () => {
      const raw = await chrome.storage.session.get('rednote.download.tasks');
      const list = raw['rednote.download.tasks'] || [];
      const t = list.pop();
      return JSON.stringify({
        summary: t?.summary,
        items: (t?.items || []).map(i => ({
          state: i.state, received: i.bytesReceived, total: i.totalBytes, name: i.filename,
        })),
      });
    })()
  `);
  const p = JSON.parse(progress);
  check(
    '三个文件全部完成',
    p.summary?.completed === 3 && p.items.every((i) => i.state === 'completed'),
    progress,
  );
  check(
    '每个文件的字节数都跟落盘大小一致',
    p.items.every((i) => {
      const hit = files.find((f) => f.path.endsWith(i.name?.split('/').pop() ?? ''));
      return hit && hit.size === i.received;
    }),
    JSON.stringify(p.items),
  );

  /* ---------------------------------------------------------------- */
  /* 5. 面板显示保存位置，而不是「下载列表」                             */
  /* ---------------------------------------------------------------- */
  await cdp.eval(`
    (() => {
      const sr = document.querySelector('rednote-root').shadowRoot;
      const fab = sr.querySelector('.rn-fab');
      if (fab) fab.click();
      return true;
    })()
  `);
  await sleep(600);
  const footer = await cdp.eval(`
    (() => {
      const sr = document.querySelector('rednote-root').shadowRoot;
      return JSON.stringify({
        sub: sr.querySelector('.rn-footer-sub')?.textContent || '',
        buttons: [...sr.querySelectorAll('.rn-footer .rn-btn')].map(b => b.textContent.trim()),
      });
    })()
  `);
  check('面板副标题里写着保存位置', /保存到/.test(footer), footer);

  cleanup();
  const passed = results.filter((r) => r.ok).length;
  console.log(`\n═══ 结果：${passed}/${results.length} 通过 ═══`);
  if (passed !== results.length) process.exitCode = 1;
}

main().catch((err) => {
  console.error('E2E 失败:', err);
  try {
    chrome?.kill();
  } catch {
    /* ignore */
  }
  process.exitCode = 1;
});
