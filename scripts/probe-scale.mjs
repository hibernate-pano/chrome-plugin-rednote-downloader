/**
 * 规模探针：批量下载到几百个文件时，到底哪里变慢了。
 *
 * 用法：node scripts/probe-scale.mjs [文件数] [模式] [并发数]
 *   模式：browser（交给 Chrome 逐个下）| zip（打成一个包再下）
 * 前置：npm run build
 *
 * 用户反馈「下载超过一两百个文件后系统变得很卡，甚至报错」。
 * 这个脚本不猜，直接量：
 *   1. 解析阶段：300 条笔记要多久？开了多少个隐藏 iframe？发了多少请求？
 *      —— 用户说的「卡」主要出在这一步，不是下载那一步。
 *   2. 下载阶段：Chrome 里多了几条下载记录？磁盘上多了几个文件？总共多少字节？
 *      —— 这是「系统要处理多少个文件事件」的代理指标。
 *   3. 扩展自己的开销：storage.session 写盘次数、往页面推的消息量
 *   4. 墙上时间
 *
 * 媒体走本地假服务器（小文件），这样量到的就是「每个文件的固定开销」，
 * 不被网络带宽干扰。
 */
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import https from 'node:https';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');

const FILE_COUNT = Number(process.argv[2] || 300);
const MODE = process.argv[3] || 'zip';
const CONCURRENCY = Number(process.argv[4] || 3);
const MEDIA_BYTES = 64 * 1024;

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

/**
 * 自签证书。
 *
 * 假站点必须走 https：扩展会把 http:// 的媒体地址改成 https://，
 * 本地 http 端口就取不到了。Chrome 用 --ignore-certificate-errors 放行。
 */
let cert = null;
function makeCert(dir) {
  const key = path.join(dir, 'key.pem');
  const crt = path.join(dir, 'cert.pem');
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', key, '-out', crt, '-days', '1', '-subj', '/CN=127.0.0.1',
  ], { stdio: 'ignore' });
  cert = { key: fs.readFileSync(key), cert: fs.readFileSync(crt) };
}

/* ------------------------------------------------------------------ */
/* 假站点                                                              */
/* ------------------------------------------------------------------ */

const AUTHOR = 'scaleauthor';
const NOTES = Array.from({ length: FILE_COUNT }, (_, i) => ({
  id: `scalenote${String(i + 1).padStart(5, '0')}`,
  token: `scale-token-${i + 1}`,
  title: `规模测试 ${i + 1}`,
}));

/**
 * 主页的状态：形状对齐真实的 user_posted 响应。
 *
 * 媒体用视频而不是图片 —— 图片直链会被扩展改写成 xhscdn 的域名
 * （那是给真实站点用的），本地假地址就取不到了；视频直链是原样用的。
 */
function profileState(origin) {
  return {
    user: {
      userPageData: { basicInfo: { nickname: AUTHOR } },
      notes: NOTES.map((n) => ({
        id: n.id,
        xsec_token: n.token,
        note_card: {
          display_title: n.title,
          type: 'video',
          cover: { url_default: `${origin}/cover.webp` },
          interact_info: { liked_count: 42 },
        },
      })),
    },
    note: { firstNoteId: NOTES[0].id, noteDetailMap: {} },
  };
}

function profileHtml(origin) {
  const cards = NOTES.map(
    (n) => `
      <section class="note-item">
        <a href="/explore/${n.id}?xsec_token=${n.token}">
          <img src="${origin}/cover.webp" alt="" />
          <span class="title">${n.title}</span>
        </a>
      </section>`,
  ).join('');

  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<title>${AUTHOR} - 小红书</title>
<script>window.__INITIAL_STATE__ = ${JSON.stringify(profileState(origin))};</script>
</head><body><div id="app"><div class="feeds-container">${cards}</div></div></body></html>`;
}

function exploreHtml(note, origin) {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<title>${note.title} - 小红书</title>
<script>window.__INITIAL_STATE__ = ${JSON.stringify({
    note: {
      firstNoteId: note.id,
      noteDetailMap: {
        [note.id]: {
          note: {
            noteId: note.id,
            type: 'video',
            title: note.title,
            desc: '规模测试',
            user: { nickname: AUTHOR, userId: 'scaleuser0001' },
            interactInfo: { likedCount: 42 },
            imageList: [],
            video: {
              media: {
                stream: {
                  h264: [
                    {
                      masterUrl: `${origin}/media/${note.id}.mp4`,
                      backupUrls: [],
                      width: 1080,
                      height: 1920,
                      duration: 10,
                      size: MEDIA_BYTES,
                      format: 'mp4',
                    },
                  ],
                },
              },
            },
          },
        },
      },
    },
  })};</script>
</head><body></body></html>`;
}

/* ------------------------------------------------------------------ */
/* Service Worker 探针                                                 */
/* ------------------------------------------------------------------ */

/**
 * 统计文件系统调用次数。
 *
 * 关键：FileSystemDirectoryHandle.prototype 是可以改的 ——
 * 改完之后所有从 IndexedDB 读出来的句柄都会走我们的计数器。
 * 这些计数就是「操作系统要处理的文件事件数」的代理指标。
 */
const ensureProbe = `
  (() => {
    if (!globalThis.__probe) {
      globalThis.__probe = {
        fs: { getDir: 0, getFile: 0, createWritable: 0, move: 0, remove: 0, write: 0 },
        storageWrites: 0, storageBytes: 0, msgs: 0, msgBytes: 0, downloads: 0, search: 0,
      };
      const p = globalThis.__probe;
      if (!globalThis.__probePatched) {
        globalThis.__probePatched = true;
        const D = FileSystemDirectoryHandle.prototype;
        const origGetDir = D.getDirectoryHandle;
        D.getDirectoryHandle = function (...a) { p.fs.getDir++; return origGetDir.apply(this, a); };
        const origGetFile = D.getFileHandle;
        D.getFileHandle = function (...a) { p.fs.getFile++; return origGetFile.apply(this, a); };
        const origRemove = D.removeEntry;
        D.removeEntry = function (...a) { p.fs.remove++; return origRemove.apply(this, a); };
        const F = FileSystemFileHandle.prototype;
        const origWritable = F.createWritable;
        F.createWritable = function (...a) {
          p.fs.createWritable++;
          return origWritable.apply(this, a).then((s) => {
            const origWrite = s.write.bind(s);
            s.write = (chunk) => { p.fs.write++; return origWrite(chunk); };
            return s;
          });
        };
        if (F.move) {
          const origMove = F.move;
          F.move = function (...a) { p.fs.move++; return origMove.apply(this, a); };
        }
        const origSet = chrome.storage.session.set.bind(chrome.storage.session);
        chrome.storage.session.set = (obj) => {
          p.storageWrites++;
          p.storageBytes += JSON.stringify(obj).length;
          return origSet(obj);
        };
        const origSend = chrome.tabs.sendMessage.bind(chrome.tabs);
        chrome.tabs.sendMessage = (...a) => {
          const msg = a[1];
          if (msg && msg.type === 'DOWNLOAD_PROGRESS') {
            p.msgs++;
            p.msgBytes += JSON.stringify(msg.progress || []).length;
          }
          return origSend(...a);
        };
        const origDownload = chrome.downloads.download.bind(chrome.downloads);
        chrome.downloads.download = (...a) => { p.downloads++; return origDownload(...a); };
      }
    }
    return JSON.stringify(globalThis.__probe);
  })()
`;

/* ------------------------------------------------------------------ */
/* 主流程                                                              */
/* ------------------------------------------------------------------ */

const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rn-scale-'));
const testDist = path.join(profileDir, 'dist');
let chrome;

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
      }, 120000);
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

async function main() {
  makeCert(profileDir);
  const mediaBuffer = Buffer.alloc(MEDIA_BYTES, 7);
  let reqCount = 0;
  const server = https.createServer(cert, (req, res) => {
    reqCount += 1;
    const url = new URL(req.url, 'http://127.0.0.1');
    // 扩展的 Service Worker 跨域取媒体，需要 CORS 头
    res.setHeader('access-control-allow-origin', '*');
    res.setHeader('access-control-expose-headers', 'Content-Length');
    if (url.pathname.startsWith('/media/')) {
      res.setHeader('content-type', 'video/mp4');
      res.setHeader('content-length', String(mediaBuffer.length));
      return void res.end(mediaBuffer);
    }
    if (url.pathname.startsWith('/cover.webp')) {
      res.setHeader('content-type', 'image/webp');
      // 必须给缓存头：真实站点的封面在 CDN 上有缓存，
      // 没有缓存头的话 300 张封面会把浏览器到本站的 6 条连接占满，
      // 解析笔记用的 iframe 加载就排在后面 —— 那是假站点的毛病，不是扩展的。
      res.setHeader('cache-control', 'public, max-age=3600');
      return void res.end(mediaBuffer);
    }
    res.setHeader('content-type', 'text/html; charset=utf-8');
    if (url.pathname.startsWith('/user/profile/')) {
      return void res.end(profileHtml(`http://127.0.0.1:${port}`));
    }
    const explore = url.pathname.match(/^\/explore\/([A-Za-z0-9_-]+)/);
    if (explore) {
      const note = NOTES.find((n) => n.id === explore[1]);
      if (note) return void res.end(exploreHtml(note, `http://127.0.0.1:${port}`));
    }
    res.end('<!doctype html><html><body>ok</body></html>');
  });

  const port = 9600 + (process.pid % 150);
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  const origin = `https://127.0.0.1:${port}`;
  console.log(`▶ 假站点：${origin}`);
  console.log(`▶ 规模：${FILE_COUNT} 个文件 / 模式 ${MODE} / 并发 ${CONCURRENCY}`);

  fs.cpSync(dist, testDist, { recursive: true });
  const manifestPath = path.join(testDist, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  for (const cs of manifest.content_scripts) cs.matches.push(`${origin}/*`);
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

  // 未打包扩展的 ID 由**真实路径**派生（macOS 上 /var 是 /private/var 的软链）
  const extId = (() => {
    const hex = createHash('sha256').update(fs.realpathSync(testDist)).digest('hex').slice(0, 32);
    let id = '';
    for (const c of hex) id += String.fromCharCode(97 + parseInt(c, 16));
    return id;
  })();

  const debugPort = port + 500;
  chrome = spawn(
    resolveChrome(),
    [
      `--remote-debugging-port=${debugPort}`,
      `--user-data-dir=${profileDir}`,
      `--disable-extensions-except=${testDist}`,
      `--load-extension=${testDist}`,
      '--no-first-run',
      '--no-default-browser-check',
      // 假站点用的是自签证书
      '--ignore-certificate-errors',
      'about:blank',
    ],
    { stdio: 'ignore' },
  );

  await sleep(4000);
  let sw = null;
  for (let i = 0; i < 60 && !sw; i += 1) {
    let targets = [];
    try {
      targets = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
    } catch {
      await sleep(300); // 浏览器还没起来
      continue;
    }
    const target = targets.find(
      (t) => t.type === 'service_worker' && t.url.startsWith(`chrome-extension://${extId}/`),
    );
    if (target) sw = await connect(target.webSocketDebuggerUrl);
    else await sleep(300);
  }
  if (!sw) throw new Error('找不到 Service Worker');

  // 装探针（SW 可能被杀，探针要能重装）
  const install = async () => {
    await sw.eval(ensureProbe);
  };
  await install();

  // 切到指定引擎
  await sw.eval(
    `(async () => {
      await chrome.storage.local.set({ 'rednote.settings': { downloadMode: '${MODE}', concurrency: ${CONCURRENCY} } });
      return 'ok';
    })()`,
  );

  // 打开主页
  const pageTarget = await (async () => {
    const targets = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
    return targets.find((t) => t.type === 'page');
  })();
  const page = await connect(pageTarget.webSocketDebuggerUrl);
  await page.send('Page.enable');
  await page.send('Runtime.enable');
  // 把下载目录指到临时目录：别往用户真实的「下载」文件夹里丢几百个测试文件
  const downloadDir = path.join(profileDir, 'Downloads');
  fs.mkdirSync(downloadDir, { recursive: true });
  await page.send('Browser.setDownloadBehavior', {
    behavior: 'allow',
    downloadPath: downloadDir,
    eventsEnabled: false,
  });
  await page.send('Page.navigate', { url: `${origin}/user/profile/scaleuser0001` });
  await sleep(2500);

  // 盯住 iframe 的创建：只看「当前有几个」会漏掉已经删掉的 ——
  // 而「曾经开过多少个」正是判断有没有走快路的依据。
  await page.eval(`
    (() => {
      window.__iframeCreated = 0;
      window.__iframeMax = 0;
      const scan = () => {
        const n = document.querySelectorAll('iframe').length;
        if (n > window.__iframeMax) window.__iframeMax = n;
      };
      new MutationObserver((records) => {
        for (const r of records) {
          for (const node of r.addedNodes) {
            if (node.tagName === 'IFRAME') window.__iframeCreated += 1;
          }
        }
        scan();
      }).observe(document.documentElement, { childList: true, subtree: true });
      setInterval(scan, 100);
      return true;
    })()
  `);

  // 打开面板，等扫描出卡片
  await page.eval(`
    (() => {
      const sr = document.querySelector('rednote-root').shadowRoot;
      const fab = sr.querySelector('.rn-fab');
      if (fab) fab.click();
      return true;
    })()
  `);
  // 等扫描完（扫描要逐条取详情，卡片是节流渲染的）
  let cardCount = 0;
  const scanStart = Date.now();
  let scanMs = 0;
  for (let i = 0; i < 60; i += 1) {
    await sleep(500);
    cardCount = await page.eval(
      `document.querySelector('rednote-root').shadowRoot.querySelectorAll('.rn-card').length`,
    );
    if (cardCount >= FILE_COUNT) {
      scanMs = Date.now() - scanStart;
      break;
    }
  }
  const scanIframes = await page.eval(
    `JSON.stringify({ created: window.__iframeCreated, max: window.__iframeMax })`,
  );
  console.log(
    `  扫出卡片：${cardCount}（用时 ${scanMs}ms / 隐藏 iframe ${scanIframes} / 请求数=${reqCount}）`,
  );

  const diag = await page.eval(`
    (() => {
      const sr = document.querySelector('rednote-root').shadowRoot;
      const vm = sr.querySelector('.rn-panel')?.__vm;
      return JSON.stringify({
        hasPanel: !!sr.querySelector('.rn-panel'),
        cards: sr.querySelectorAll('.rn-card').length,
        buttons: [...sr.querySelectorAll('.rn-btn')].map(b => b.textContent.trim()).slice(0, 12),
      });
    })()
  `);
  console.log(`  面板状态：${diag}`);

  // 全选并开始下载
  await page.eval(`
    (() => {
      const sr = document.querySelector('rednote-root').shadowRoot;
      const all = [...sr.querySelectorAll('.rn-toolbar-right .rn-btn')].find(b => /全选/.test(b.textContent));
      if (all) all.click();
      const start = sr.querySelector('.rn-footer .rn-btn[data-variant="primary"]');
      if (start) start.click();
      return true;
    })()
  `);
  await sleep(1500);
  const diag2 = await page.eval(`
    (() => {
      const sr = document.querySelector('rednote-root').shadowRoot;
      return JSON.stringify({
        footer: sr.querySelector('.rn-footer-sub')?.textContent || '',
        body: sr.querySelector('.rn-panel-body')?.textContent?.slice(0, 200) || '',
      });
    })()
  `);
  console.log(`  点完下载：${diag2}`);

  const t0 = Date.now();
  let done = false;
  let elapsed = 0;
  for (let i = 0; i < 600 && !done; i += 1) {
    await sleep(500);
    await install(); // 探针重装
    const s = JSON.parse(
      await sw.eval(`
        (async () => {
          const raw = await chrome.storage.session.get('rednote.download.tasks');
          const list = raw['rednote.download.tasks'] || [];
          const t = list.pop();
          return JSON.stringify({
            summary: t?.summary || null,
            states: (t?.items || []).reduce((acc, i) => { acc[i.state] = (acc[i.state] || 0) + 1; return acc; }, {}),
            errors: (t?.items || []).filter(i => i.error).map(i => i.error).slice(0, 3),
            urls: (t?.items || []).slice(0, 2).map(i => i.filename),
            srcs: (t?.sources || []).slice(0, 2).map(s => s[1]?.url),
          });
        })()
      `),
    );
    elapsed = Date.now() - t0;
    const sum = s.summary;
    if (i % 10 === 0) {
      const footer = await page.eval(`
        (() => {
          const sr = document.querySelector('rednote-root').shadowRoot;
          return (sr.querySelector('.rn-footer-title')?.textContent || '') + ' | ' + (sr.querySelector('.rn-footer-sub')?.textContent || '');
        })()
      `);
      const iframes = await page.eval(`document.querySelectorAll('iframe').length`);
      console.log(
        `  [${Math.round(elapsed / 1000)}s] 状态=${JSON.stringify(s.states)} 汇总=${JSON.stringify(sum)} iframe=${iframes} 请求数=${reqCount} 面板=${footer}`,
      );
    }
    if (sum && sum.finishedAt) {
      done = true;
      console.log(`\n  用时 ${elapsed}ms`);
      console.log(`  汇总 ${JSON.stringify(sum)}`);
      console.log(`  状态分布 ${JSON.stringify(s.states)}`);
      if (s.errors?.length) console.log(`  报错样例 ${JSON.stringify(s.errors)}`);
      if (s.urls?.length) console.log(`  文件名样例 ${JSON.stringify(s.urls)}`);
      if (s.srcs?.length) console.log(`  下载地址样例 ${JSON.stringify(s.srcs)}`);
    }
  }

  const probe = JSON.parse(await sw.eval(ensureProbe));
  const iframeStats = await page.eval(
    `JSON.stringify({ created: window.__iframeCreated, max: window.__iframeMax })`,
  );
  console.log('\n── 解析笔记用了多少隐藏 iframe ──');
  console.log(`  累计创建                  : ${JSON.parse(iframeStats).created}`);
  console.log(`  同时存在过的最大值        : ${JSON.parse(iframeStats).max}`);

  console.log('\n── 文件系统调用（操作系统要处理的事件数）──');
  console.log(`  建目录 getDirectoryHandle : ${probe.fs.getDir}`);
  console.log(`  取/建文件 getFileHandle   : ${probe.fs.getFile}`);
  console.log(`  打开写入流 createWritable  : ${probe.fs.createWritable}`);
  console.log(`  写数据 write              : ${probe.fs.write}`);
  console.log(`  改名 move                 : ${probe.fs.move}`);
  console.log(`  删除 removeEntry          : ${probe.fs.remove}`);
  const fsTotal =
    probe.fs.getDir + probe.fs.getFile + probe.fs.createWritable + probe.fs.move + probe.fs.remove;
  console.log(`  合计（不含 write）        : ${fsTotal}`);

  console.log('\n── 扩展自己的开销 ──');
  console.log(`  storage.session 写盘次数  : ${probe.storageWrites}`);
  console.log(`  storage.session 写入字节  : ${(probe.storageBytes / 1024 / 1024).toFixed(2)} MB`);
  console.log(`  往页面推的消息次数        : ${probe.msgs}`);
  console.log(`  往页面推的消息字节        : ${(probe.msgBytes / 1024).toFixed(1)} KB`);
  console.log(`  chrome.downloads.download  : ${probe.downloads}`);

  // 浏览器里的下载记录：用户看到的就是这些
  const downloadRecords = JSON.parse(
    await sw.eval(`
      (async () => {
        const list = await chrome.downloads.search({});
        return JSON.stringify(list.map(d => ({
          id: d.id, state: d.state, bytes: d.totalBytes,
          name: (d.filename || '').split('/').pop(),
        })));
      })()
    `),
  );
  console.log('\n── 浏览器里的下载记录 ──');
  console.log(`  记录条数                  : ${downloadRecords.length}`);
  console.log(`  合计字节                  : ${(downloadRecords.reduce((n, d) => n + (d.bytes || 0), 0) / 1024 / 1024).toFixed(2)} MB`);
  for (const d of downloadRecords.slice(0, 3)) console.log(`    #${d.id} ${d.state} ${d.name} ${d.bytes}B`);

  // 磁盘上真正落了几个文件 —— 「系统要处理多少个文件事件」的答案
  const onDisk = fs.existsSync(downloadDir)
    ? fs.readdirSync(downloadDir, { withFileTypes: true, recursive: true })
        .filter((e) => e.isFile())
        .map((e) => {
          const p = path.join(e.parentPath || e.path, e.name);
          return { path: path.relative(downloadDir, p), size: fs.statSync(p).size };
        })
    : [];
  console.log('\n── 最终落盘（下载目录）──');
  console.log(`  文件个数                  : ${onDisk.length}`);
  console.log(`  总字节                    : ${(onDisk.reduce((n, f) => n + f.size, 0) / 1024 / 1024).toFixed(2)} MB`);
  if (onDisk.length <= 5) {
    for (const f of onDisk) console.log(`    ${f.path} = ${f.size}B`);
  } else {
    for (const f of onDisk.slice(0, 3)) console.log(`    ${f.path} = ${f.size}B`);
    console.log(`    …… 还有 ${onDisk.length - 3} 个`);
  }

  // 扩展私有文件系统里的临时文件（下完就删了，正常应该是空的）
  const fileList = await sw.eval(`
    (async () => {
      const root = await navigator.storage.getDirectory();
      const out = [];
      async function walk(dir, prefix) {
        for await (const [name, handle] of dir.entries()) {
          const p = prefix ? prefix + '/' + name : name;
          if (handle.kind === 'directory') await walk(handle, p);
          else { const f = await handle.getFile(); out.push({ path: p, size: f.size }); }
        }
      }
      try { await walk(root, ''); } catch {}
      return JSON.stringify(out);
    })()
  `);
  const files = JSON.parse(fileList);
  console.log('\n── 扩展私有目录（OPFS）残留 ──');
  console.log(`  文件个数                  : ${files.length}`);
  for (const f of files.slice(0, 5)) console.log(`    ${f.path} = ${f.size}B`);

  chrome.kill();
  server.close();
  console.log(`\n═══ 用时 ${elapsed}ms / ${FILE_COUNT} 个文件 / 模式 ${MODE} ═══`);
}

main().catch((err) => {
  console.error('探针失败:', err);
  try { chrome?.kill(); } catch {}
  process.exit(1);
});
