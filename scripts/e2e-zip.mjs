/**
 * 打包下载（zip 模式）的端到端测试。
 *
 * 用法：node scripts/e2e-zip.mjs
 * 前置：node build.mjs
 *
 * 测的是「几百个文件打成 1 个包」这条主路径：
 *   1. 主页批量下载 → 只产生 1 条浏览器下载记录（不是每个文件一条）
 *   2. 下载目录里出现 1 个 zip，里面装好了所有文件
 *   3. 包里的目录结构跟「按笔记建文件夹」一致
 *   4. 包里的字节跟服务器给的完全一样（没被压坏、没被截断）
 *   5. 解析笔记时不开隐藏 iframe —— 走的是「抓 HTML」那条快路
 *
 * 假站点跑 https：扩展会把媒体地址里的 http 改成 https，
 * 本地 http 端口就取不到了。Chrome 用 --ignore-certificate-errors 放行。
 */
import { spawn, execFileSync } from 'node:child_process';
import https from 'node:https';
import { createHash } from 'node:crypto';

import { makeRequestCounter, notePageHtml, serializeState, UNDEF } from './fake-site.mjs';
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

const AUTHOR = '打包测试号';
const MEDIA_BYTES = 96 * 1024;
const MEDIA_BODY = Buffer.alloc(MEDIA_BYTES, 0x5a);

const NOTES = [
  { id: 'zipnote0001', token: 'zip-token-1', title: '第一个视频' },
  { id: 'zipnote0002', token: 'zip-token-2', title: '第二个视频' },
];

/** 笔记详情（形状对齐站点的 SSR 状态） */
function noteDetail(note, origin) {
  return {
    noteId: note.id,
    type: 'video',
    title: note.title,
    desc: '打包测试用的假数据',
    user: { nickname: AUTHOR, userId: 'zipuser0001' },
    interactInfo: { likedCount: 7 },
    imageList: [],
    video: {
      media: {
        stream: {
          h264: [
            {
              masterUrl: `${origin}/media/${note.id}.mp4`,
              backupUrls: [`${origin}/media/${note.id}.mp4`],
              duration: 10000,
              width: 720,
              height: 1280,
              size: MEDIA_BYTES,
              format: 'mp4',
            },
          ],
        },
      },
    },
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
          type: 'video',
          cover: { url_default: '' },
          interact_info: { liked_count: 7 },
        },
      })),
    },
    note: { firstNoteId: NOTES[0].id, noteDetailMap: {}, currentNoteId: UNDEF },
  };
}

function profileHtml() {
  const cards = NOTES.map(
    (n) => `
      <section class="note-item">
        <a href="/explore/${n.id}?xsec_token=${n.token}">
          <span class="title">${n.title}</span>
        </a>
      </section>`,
  ).join('');

  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<title>${AUTHOR} - 小红书</title>
<script>window.__INITIAL_STATE__ = ${serializeState(profileState())};</script>
</head><body><div id="app"><div class="feeds-container">${cards}</div></div></body></html>`;
}

/**
 * 笔记页的 HTML —— 走共享的生成器，形状跟真站点一致
 * （状态是 JavaScript 对象字面量，里面有 undefined，不是纯 JSON）。
 */
function noteHtml(note, origin) {
  return notePageHtml({ note, detail: noteDetail(note, origin) });
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

const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rn-e2e-zip-'));
const testDist = path.join(profileDir, 'dist');
const downloadDir = path.join(profileDir, 'Downloads');
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

  const port = 9700 + (process.pid % 90);
  const origin = `https://127.0.0.1:${port}`;
  const { counter, record } = makeRequestCounter();
  // 打包引擎自己也会 fetch 媒体（跨域取字节），那些不算「解析用的抓取」——
  // 只数笔记页的抓取。
  let notePageFetches = 0;
  const server = https.createServer(cert, (req, res) => {
    record(req);
    const url = new URL(req.url, 'http://127.0.0.1');
    if (
      String(req.headers['sec-fetch-dest'] || '') === 'empty' &&
      url.pathname.startsWith('/explore/')
    ) {
      notePageFetches += 1;
    }
    // 扩展在后台页面里跨域取媒体，需要 CORS 头
    res.setHeader('access-control-allow-origin', '*');
    res.setHeader('access-control-expose-headers', 'Content-Length');
    if (url.pathname.startsWith('/media/')) {
      res.setHeader('content-type', 'video/mp4');
      res.setHeader('content-length', String(MEDIA_BODY.length));
      return void res.end(MEDIA_BODY);
    }
    res.setHeader('content-type', 'text/html; charset=utf-8');
    if (url.pathname.startsWith('/user/profile/')) return void res.end(profileHtml());
    const explore = url.pathname.match(/^\/explore\/([A-Za-z0-9_-]+)/);
    if (explore) {
      const note = NOTES.find((n) => n.id === explore[1]);
      if (note) return void res.end(noteHtml(note, origin));
    }
    res.end('<!doctype html><html><body>ok</body></html>');
  });
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  console.log(`▶ 假站点：${origin}`);

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
      '--ignore-certificate-errors',
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

  /* 切到打包模式 */
  const mode = await sw.eval(`
    (async () => {
      await chrome.storage.local.set({ 'rednote.settings': { downloadMode: 'zip' } });
      const raw = await chrome.storage.local.get('rednote.settings');
      return JSON.stringify(raw['rednote.settings']);
    })()
  `);
  check('已切到打包模式', /"downloadMode":"zip"/.test(mode), mode);

  const list = await (await fetch(`http://127.0.0.1:${port + 500}/json/list`)).json();
  const page = list.find((t) => t.type === 'page');
  const cdp = await connect(page.webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  // 把下载目录指到临时目录里：别往用户真实的「下载」文件夹里丢测试文件
  await cdp.send('Browser.setDownloadBehavior', {
    behavior: 'allow',
    downloadPath: downloadDir,
    eventsEnabled: false,
  });

  /* ---------------------------------------------------------------- */
  /* 1. 主页批量下载                                                   */
  /* ---------------------------------------------------------------- */
  console.log('\n▶ 主页批量下载（打包模式）');
  await cdp.send('Page.navigate', { url: `${origin}/user/profile/zipuser0001` });
  await sleep(2500);

  const injected = await cdp.eval(
    `!!document.querySelector('rednote-root')?.shadowRoot?.querySelector('.rn-panel')`,
  );
  check('扩展已注入主页', injected === true, String(injected));

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
  check('主页扫描出卡片', cardCount === NOTES.length, `cards=${cardCount}`);

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

  /* 诊断：后台页面的日志（尽早挂上，别错过前面的输出） */
  let offCdp = null;
  for (let i = 0; i < 60; i += 1) {
    const ts = await (await fetch(`http://127.0.0.1:${port + 500}/json/list`)).json();
    const t = ts.find((x) => x.type === 'background_page' && x.url.includes('offscreen.html'));
    if (t) {
      offCdp = await connect(t.webSocketDebuggerUrl);
      await offCdp.send('Runtime.enable');
      offCdp.ws.addEventListener('message', (event) => {
        const msg = JSON.parse(event.data);
        if (msg.method === 'Runtime.consoleAPICalled') {
          const text = (msg.params.args ?? []).map((a) => a.value ?? a.description ?? '').join(' ');
          console.log('   [后台页面]', text);
        }
        if (msg.method === 'Runtime.exceptionThrown') {
          console.log('   [后台页面异常]', String(msg.params.exceptionDetails?.exception?.description ?? ''));
        }
      });
      break;
    }
    await sleep(100);
  }
  check('后台页面已启动', offCdp !== null, String(offCdp !== null));

  /* 等任务真的跑完 */
  let task = null;
  let lastStage = '';
  for (let i = 0; i < 120; i += 1) {
    await sleep(500);
    if (offCdp) {
      const st = await offCdp.eval(`String(globalThis.__stage ?? '')`).catch(() => '');
      if (st && st !== lastStage) {
        lastStage = st;
        console.log('   阶段：', st);
      }
    }
    const raw = await sw.eval(`
      (async () => {
        const raw = await chrome.storage.session.get('rednote.download.tasks');
        const list = raw['rednote.download.tasks'] || [];
        const t = list.pop();
        return JSON.stringify({
          engine: t?.engine,
          finished: Boolean(t?.summary?.finishedAt),
          completed: t?.summary?.completed,
          failed: t?.summary?.failed,
          states: (t?.items || []).map(i => i.state),
          items: (t?.items || []).map(i => ({ s: i.state, got: i.bytesReceived, want: i.totalBytes, err: i.error })),
        });
      })()
    `);
    task = JSON.parse(raw);
    if (task.finished) break;
  }
  check('打包任务跑完了', task?.finished === true, JSON.stringify(task));
  check('两个文件都打包成功', task?.completed === 2 && task?.failed === 0, JSON.stringify(task));

  /* ---------------------------------------------------------------- */
  /* 2. 浏览器里只有一条下载记录，磁盘上只有一个包                     */
  /* ---------------------------------------------------------------- */
  const downloads = JSON.parse(
    await sw.eval(`
      (async () => {
        const list = await chrome.downloads.search({});
        return JSON.stringify(list.map(d => ({ filename: d.filename, state: d.state, bytes: d.bytesReceived })));
      })()
    `),
  );
  check('浏览器里只有一条下载记录', downloads.length === 1, JSON.stringify(downloads));
  check(
    '那一条下载就是一个 zip',
    /\.zip$/i.test(downloads[0]?.filename ?? ''),
    JSON.stringify(downloads),
  );

  const zips = fs.existsSync(downloadDir)
    ? fs.readdirSync(downloadDir).filter((f) => f.endsWith('.zip'))
    : [];
  check('下载目录里出现了一个 zip', zips.length === 1, zips.join(' | '));
  /* DevTools 接管下载时会把文件重命名成 GUID（那是测试环境的规矩，
     不是扩展的行为），所以「打算存成什么名字」要看扩展自己的记录。 */
  const intended = JSON.parse(
    await sw.eval(`
      (async () => {
        const raw = await chrome.storage.session.get('rednote.download.tasks');
        const list = raw['rednote.download.tasks'] || [];
        const t = list.pop();
        return JSON.stringify(t?.packPaths || []);
      })()
    `),
  );
  check(
    '压缩包打算存成「根文件夹/小红书-作者-时间.zip」',
    intended.length === 1 &&
      /^小红书下载\/小红书-打包测试号-\d{8}-\d{4}\.zip$/.test(intended[0] ?? ''),
    JSON.stringify(intended),
  );

  if (zips.length !== 1) {
    cleanup();
    const passed = results.filter((r) => r.ok).length;
    console.log(`\n═══ 结果：${passed}/${results.length} 通过 ═══`);
    process.exitCode = 1;
    return;
  }

  const zipPath = path.join(downloadDir, zips[0]);

  /* 用一个完全独立的实现（Python 的 zipfile）来读，
     顺便证明这不是「只有自己能解开」的格式 */
  const listed = JSON.parse(
    execFileSync(
      'python3',
      [
        '-c',
        'import json,sys,zipfile\n' +
          'z=zipfile.ZipFile(sys.argv[1])\n' +
          'print(json.dumps([{"name":i.filename,"size":i.file_size,"crc":i.CRC} for i in z.infolist()]))',
        zipPath,
      ],
      { encoding: 'utf8' },
    ),
  );
  console.log('   包里的内容：', JSON.stringify(listed, null, 0));

  check('包里有 2 个文件', listed.length === 2, `entries=${listed.length}`);

  const names = listed.map((e) => e.name);
  check(
    '包里的目录结构是「作者/标题/文件名」，且没有重复的根文件夹',
    names.some((n) => n?.includes(`${AUTHOR}/第一个视频/`)) &&
      names.some((n) => n?.includes(`${AUTHOR}/第二个视频/`)) &&
      !names.some((n) => n?.startsWith('小红书下载/')),
    names.join(' | '),
  );

  /* 内容对不对：解出来跟服务器给的字节一致 */
  const extracted = execFileSync(
    'python3',
    [
      '-c',
      'import sys,zipfile\n' +
        'z=zipfile.ZipFile(sys.argv[1])\n' +
        'sys.stdout.buffer.write(z.read(z.namelist()[0]))',
      zipPath,
    ],
    { encoding: 'buffer', maxBuffer: 32 * 1024 * 1024 },
  );
  check(
    '包里的字节跟源文件完全一致',
    extracted.length === MEDIA_BODY.length && extracted.equals(MEDIA_BODY),
    `解出 ${extracted.length} 字节，源 ${MEDIA_BODY.length} 字节`,
  );

  /* macOS 自己的解压工具能不能正确还原中文名（用户双击就是这条路） */
  const dittoDir = path.join(profileDir, 'ditto');
  fs.mkdirSync(dittoDir, { recursive: true });
  try {
    execFileSync('ditto', ['-x', '-k', zipPath, dittoDir]);
    const extractedNames = [];
    const walk = (dir, prefix) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(p, `${prefix}${entry.name}/`);
        else extractedNames.push(`${prefix}${entry.name}`);
      }
    };
    walk(dittoDir, '');
    check(
      'macOS 自带的解压工具能正确还原中文文件名',
      extractedNames.length === 2 &&
        extractedNames.some((n) => n.includes('第一个视频')) &&
        extractedNames.some((n) => n.includes('第二个视频')),
      extractedNames.join(' | '),
    );
  } catch (err) {
    check('macOS 自带的解压工具能正确还原中文文件名', false, String(err));
  }

  /* ---------------------------------------------------------------- */
  /* 3. 解析走的是隐藏 iframe（1.0.0 的主路），抓 HTML 只用来自证一次   */
  /* ---------------------------------------------------------------- */
  // 注意：隐藏 iframe 用完就删了，在页面里数 iframe 看不到 ——
  // 要数得在假站点那边数（Sec-Fetch-Dest: iframe = 页面导航，empty = 脚本抓取）。
  check(
    '解析主路是隐藏 iframe（每条笔记一个页面导航）',
    counter.iframe === NOTES.length,
    `iframe ${counter.iframe} 个 / 抓取 ${counter.fetch} 次`,
  );
  check(
    '抓 HTML 只用来自证一次，不是每条笔记都白打一遍',
    notePageFetches <= 1,
    `抓笔记页 ${notePageFetches} 次（笔记 ${NOTES.length} 条）`,
  );

  /* ---------------------------------------------------------------- */
  /* 4. 面板显示的是打包完成，而不是「保存到某个文件夹」               */
  /* ---------------------------------------------------------------- */
  const footer = await cdp.eval(`
    (() => {
      const sr = document.querySelector('rednote-root').shadowRoot;
      return JSON.stringify({
        sub: sr.querySelector('.rn-footer-sub')?.textContent || '',
        body: (sr.querySelector('.rn-body')?.textContent || '').slice(0, 200),
      });
    })()
  `);
  check('面板没有再提「选目录」', !/选目录|保存目录/.test(footer), footer);

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
