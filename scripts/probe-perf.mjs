/**
 * 性能探针：量一量「批量下载」到底把浏览器拖慢在哪。
 *
 * 用法：node scripts/probe-perf.mjs [笔记数] [并发数]
 * 前置：npm run build
 *
 * 背景：用户反馈批量下载时页面卡顿，怀疑是 chrome.downloads 的调用导致的。
 * 这个脚本不猜，直接量四件事：
 *   1. 扩展在 Service Worker 里打了多少次 chrome.downloads.search
 *   2. 浏览器给扩展派了多少次 chrome.downloads.onChanged 事件
 *   3. 往页面推了多少次进度消息、载荷多大
 *   4. 页面因此重建了多少张卡片、多少个缩略图（图片重建 = 重新解码 = 卡顿）
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
const NOTE_COUNT = Number(process.argv[2] || 20);
const CONCURRENCY = Number(process.argv[3] || 3);
const SAMPLE_MS = 300;

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
/* 假站点                                                              */
/* ------------------------------------------------------------------ */

const AUTHOR = 'perfauthor';
const MEDIA_BYTES = 2 * 1024 * 1024; // 2MB

// 封面图走真实 CDN：卡片上要真的有 <img>，才量得出「缩略图被反复重建」的代价
const COVER_URL =
  'https://sns-webpic-qc.xhscdn.com/202610241249/036c3b98f180befdb20ada1f779c0111/' +
  '1040g2sg325d5f1ni4q005n341tr4na22ndh5mg8' +
  '!nd_dft_wlteh_webp_3';

// 媒体走真实 CDN：本地 http:// 的下载 Chrome 拿不到（目录建了但没有文件）
const MEDIA_URL =
  'https://sns-bak-v1.xhscdn.com/stream/79/110/258/01eab1a3bcc06cc24f037001a0c5e9440a_258.mp4';

const NOTES = Array.from({ length: NOTE_COUNT }, (_, i) => ({
  id: `perfnote${String(i + 1).padStart(4, '0')}`,
  token: `perf-token-${i + 1}`,
  title: `性能测试笔记 ${i + 1}`,
  type: 'video',
}));

function noteDetail(note) {
  return {
    noteId: note.id,
    type: 'video',
    title: note.title,
    desc: '性能测试',
    user: { nickname: AUTHOR, userId: 'perfuser0001' },
    interactInfo: { liked_count: 1 },
    imageList: [],
    video: {
      media: {
        stream: {
          h264: [
            {
              masterUrl: MEDIA_URL,
              backupUrls: [MEDIA_URL],
              duration: 1900,
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

function profileHtml() {
  const cards = NOTES.map(
    (n) => `<section class="note-item"><a href="/explore/${n.id}?xsec_token=${n.token}">
      <img src="${COVER_URL}" width="1440" height="1921">
      <span class="title">${n.title}</span></a></section>`,
  ).join('');
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<script>window.__INITIAL_STATE__ = ${JSON.stringify({
    user: {
      userPageData: { basicInfo: { nickname: AUTHOR } },
      notes: NOTES.map((n) => ({
        id: n.id,
        xsec_token: n.token,
        note_card: { display_title: n.title, type: 'video', interact_info: { liked_count: 1 } },
      })),
    },
    note: { firstNoteId: NOTES[0].id, noteDetailMap: {} },
  })};</script></head><body><div id="app"><div class="feeds-container">${cards}</div></div></body></html>`;
}

function noteHtml(note) {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
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
/* 主流程                                                              */
/* ------------------------------------------------------------------ */

const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rn-perf-'));
const testDist = path.join(profileDir, 'dist');
let chrome;

/**
 * Service Worker 侧的探针。
 *
 * 关键：探针是幂等的 —— SW 被 Chrome 杀掉再拉起时 globalThis 会清空，
 * 重新装一次探针，并把「SW 重启」记下来（这本身就是重要指标）。
 * 注意：不能断开 CDP 连接，断开会顺带把 SW 停掉，计数就永远归零。
 */
const ensureProbe = `
  (() => {
    if (!globalThis.__perf) {
      globalThis.__perf = { search: 0, changed: 0, download: 0, msgs: 0, msgBytes: 0, wrapped: false };
    }
    const p = globalThis.__perf;
    if (!p.wrapped) {
      p.wrapped = true;
      const origSearch = chrome.downloads.search.bind(chrome.downloads);
      chrome.downloads.search = (...a) => { p.search++; return origSearch(...a); };
      const origDownload = chrome.downloads.download.bind(chrome.downloads);
      chrome.downloads.download = (...a) => { p.download++; return origDownload(...a); };
      chrome.downloads.onChanged.addListener(() => { p.changed++; });
      const origSend = chrome.tabs.sendMessage.bind(chrome.tabs);
      chrome.tabs.sendMessage = (...a) => {
        const msg = a[1];
        if (msg && msg.type === 'DOWNLOAD_PROGRESS') {
          p.msgs++;
          p.msgBytes += JSON.stringify(msg.progress || []).length;
        }
        return origSend(...a);
      };
    }
    return JSON.stringify(p);
  })()
`;

/** 从 storage.session 里读任务汇总，用来判断「真的下完了」 */
const readSummary = `
  (async () => {
    try {
      const raw = await chrome.storage.session.get('rednote.download.tasks');
      const list = raw['rednote.download.tasks'] || [];
      const s = list.map(t => t.summary).filter(Boolean).pop();
      return JSON.stringify(s || {});
    } catch {
      return '{}';
    }
  })()
`;

async function main() {
  const server = createServer(async (req, res) => {
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

  const port = 9800 + (process.pid % 150);
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${port}`;
  console.log(`▶ 假站点：${origin}（${NOTE_COUNT} 条笔记）`);

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
  let targets = [];
  let pageTarget;
  let swTarget;
  for (let i = 0; i < 40; i += 1) {
    targets = await (await fetch(`http://127.0.0.1:${port + 500}/json/list`)).json();
    pageTarget = targets.find((t) => t.type === 'page');
    swTarget = targets.find(
      (t) => t.type === 'service_worker' && t.url.startsWith(`chrome-extension://${extId}/`),
    );
    if (pageTarget && swTarget) break;
    await sleep(500);
  }
  if (!pageTarget) throw new Error('找不到页面 target');
  if (!swTarget) {
    console.log('target：', targets.map((t) => `${t.type} ${t.url.slice(0, 80)}`));
    throw new Error(`找不到扩展 ${extId} 的 Service Worker target`);
  }

  const page = await connect(pageTarget.webSocketDebuggerUrl);
  const sw = await connect(swTarget.webSocketDebuggerUrl);
  await sw.send('Runtime.enable');

  // 这个探针量的是「交给浏览器下载」那条路径的调用量，
  // 所以显式把下载方式设成 browser（默认是扩展自己写盘）。
  await sw.eval(
    `chrome.storage.local.set({'rednote.settings': {downloadMode: 'browser'}}).then(() => 'ok')`,
  );
  await page.send('Page.enable');
  await page.send('Runtime.enable');
  await sw.send('Runtime.enable');
  await sw.eval(ensureProbe);

  console.log('▶ 打开假的主页…');
  await page.send('Page.navigate', { url: `${origin}/user/profile/perfuser0001?xsec_token=mock` });

  let injected = false;
  for (let i = 0; i < 40; i += 1) {
    injected = await page.eval(
      `!!document.querySelector('rednote-root')?.shadowRoot?.querySelector('.rn-fab')`,
    );
    if (injected) break;
    await sleep(400);
  }
  if (!injected) throw new Error('扩展没有注入');

  /* -------- 打点：页面侧（必须等导航完成，否则上下文会被换掉） -------- */
  await page.eval(`
    (() => {
      globalThis.__page = { cards: 0, imgs: 0, rows: 0, longTasks: 0, longTaskMs: 0 };
      const attach = () => {
        const sr = document.querySelector('rednote-root')?.shadowRoot;
        if (!sr) return false;
        const body = sr.querySelector('.rn-body') || sr;
        // 卡片是「先在游离节点里建好再挂上去」的，
        // 所以 MutationObserver 数不到内部节点 —— 得数挂上去的整块里有多少张卡
        const mo = new MutationObserver((records) => {
          for (const r of records) {
            for (const n of r.addedNodes) {
              if (!n.querySelectorAll) continue;
              globalThis.__page.cards += n.querySelectorAll('.rn-card').length;
              globalThis.__page.imgs += n.querySelectorAll('.rn-card img, .rn-row img').length;
              globalThis.__page.rows += n.querySelectorAll('.rn-row').length;
              if (n.classList && n.classList.contains('rn-grid')) {
                globalThis.__page.stacks = globalThis.__page.stacks || [];
                if (globalThis.__page.stacks.length < 12) {
                  const lines = String(new Error().stack).split(String.fromCharCode(10));
                  globalThis.__page.stacks.push(lines.slice(1, 6).join(' | '));
                }
              }
            }
          }
        });
        mo.observe(body, { childList: true, subtree: true });
        return true;
      };
      if (!attach()) {
        const iv = setInterval(() => { if (attach()) clearInterval(iv); }, 200);
      }
      try {
        new PerformanceObserver((list) => {
          for (const e of list.getEntries()) {
            globalThis.__page.longTasks++;
            globalThis.__page.longTaskMs += e.duration;
          }
        }).observe({ entryTypes: ['longtask'] });
      } catch {}
      return true;
    })()
  `);

  // 点 FAB 开始扫描
  await page.eval(`document.querySelector('rednote-root').shadowRoot.querySelector('.rn-fab').click()`);
  let cards = 0;
  for (let i = 0; i < 60; i += 1) {
    cards = await page.eval(
      `document.querySelector('rednote-root').shadowRoot.querySelectorAll('.rn-card').length`,
    );
    if (cards >= NOTE_COUNT) break;
    await sleep(500);
  }
  console.log(`▶ 扫到 ${cards} 张卡片`);

  // 并发调成用户要的档位
  await sw.eval(`
    (() => {
      chrome.storage.local.get('rednote.settings').then((raw) => {
        const cur = raw['rednote.settings'] || {};
        chrome.storage.local.set({ 'rednote.settings': { ...cur, concurrency: ${CONCURRENCY} } });
      });
      return true;
    })()
  `);
  await sleep(800);

  // 全选
  await page.eval(`
    (() => {
      const sr = document.querySelector('rednote-root').shadowRoot;
      const btn = [...sr.querySelectorAll('.rn-toolbar-right .rn-btn')].find(b => /全选/.test(b.textContent));
      if (btn) btn.click();
      return true;
    })()
  `);
  await sleep(500);

  // 等批量解析完成 —— 解析期间按钮是「解析中…」，点了没用
  let ready = false;
  for (let i = 0; i < 80; i += 1) {
    const label = await page.eval(
      `(() => { const sr = document.querySelector('rednote-root').shadowRoot;
         const b = sr.querySelector('.rn-footer .rn-btn[data-variant="primary"]');
         return b ? b.textContent.trim() : ''; })()`,
    );
    if (/开始下载/.test(label)) {
      ready = true;
      break;
    }
    await sleep(500);
  }
  if (!ready) throw new Error('批量解析一直没结束');

  console.log(`▶ 点「开始下载」（并发 ${CONCURRENCY}）…`);
  await page.eval(`
    (() => {
      const sr = document.querySelector('rednote-root').shadowRoot;
      const btn = sr.querySelector('.rn-footer .rn-btn[data-variant="primary"]');
      btn.click();
      return true;
    })()
  `);

  // 点按钮后还有一段「解析笔记」，解析完才真正开始下载 ——
  // 计时从任务创建那一刻起，解析阶段的渲染不计入
  let t0 = 0;
  for (let i = 0; i < 300; i += 1) {
    const summary = JSON.parse((await sw.eval(readSummary)) ?? '{}');
    if (summary.startedAt) {
      t0 = Date.now();
      break;
    }
    await sleep(200);
  }
  if (!t0) throw new Error('下载任务一直没启动');
  // 解析阶段已经渲染过一轮网格，基线要减掉
  const base = JSON.parse((await page.eval(`JSON.stringify(globalThis.__page || {})`)) ?? '{}');
  console.log('▶ 任务已启动，开始采样');

  // 采样
  const samples = [];
  let prev = { search: 0, changed: 0, download: 0, msgs: 0, msgBytes: 0 };
  let totals = { search: 0, changed: 0, download: 0, msgs: 0, msgBytes: 0 };
  let swRestarts = 0;
  let swGone = 0;
  let pageEvalMax = 0;
  let finished = false;
  for (let i = 0; i < 600; i += 1) {
    await sleep(SAMPLE_MS);
    let s = { search: 0, changed: 0, download: 0, msgs: 0, msgBytes: 0 };
    try {
      s = JSON.parse((await sw.eval(ensureProbe)) ?? '{}');
    } catch {
      swGone += 1;
    }
    // SW 被杀再拉起 → 计数归零，把这一轮的量补进累计
    if (s.search < prev.search) {
      swRestarts += 1;
      for (const k of Object.keys(totals)) totals[k] += s[k] ?? 0;
    } else {
      for (const k of Object.keys(totals)) totals[k] = s[k] ?? 0;
    }
    prev = s;

    const t1 = Date.now();
    const p = JSON.parse((await page.eval(`JSON.stringify(globalThis.__page || {})`)) ?? '{}');
    const pageEvalMs = Date.now() - t1;
    pageEvalMax = Math.max(pageEvalMax, pageEvalMs);
    const elapsed = (Date.now() - t0) / 1000;
    samples.push({
      t: elapsed,
      ...totals,
      cards: (p.cards ?? 0) - (base.cards ?? 0),
      imgs: (p.imgs ?? 0) - (base.imgs ?? 0),
      rows: (p.rows ?? 0) - (base.rows ?? 0),
      longTasks: (p.longTasks ?? 0) - (base.longTasks ?? 0),
      longTaskMs: (p.longTaskMs ?? 0) - (base.longTaskMs ?? 0),
      pageEvalMs,
    });
    if (!finished) {
      const summary = JSON.parse((await sw.eval(readSummary)) ?? '{}');
      if ((summary.completed ?? 0) + (summary.failed ?? 0) >= NOTE_COUNT) {
        finished = true;
        break;
      }
    }
  }

  const last = samples[samples.length - 1];
  const duration = last.t;

  console.log('\n═══ 批量下载性能实测 ═══');
  console.log(`规模：${NOTE_COUNT} 条笔记 / ${NOTE_COUNT} 个文件，并发 ${CONCURRENCY}`);
  console.log(`下载窗口：${duration.toFixed(1)} 秒\n`);
  console.log('【浏览器侧：chrome.downloads 调用量】');
  console.log(`  downloads.download 次数：${totals.download}`);
  console.log(`  downloads.search   次数：${totals.search}   （${(totals.search / duration).toFixed(1)} 次/秒）`);
  console.log(`  downloads.onChanged 次数：${totals.changed}   （${(totals.changed / duration).toFixed(1)} 次/秒）`);
  console.log(`  Service Worker 重启：${swRestarts} 次（另有 ${swGone} 轮取不到 SW）`);
  console.log('\n【消息：往页面推进度】');
  console.log(`  DOWNLOAD_PROGRESS 条数：${totals.msgs}   （${(totals.msgs / duration).toFixed(1)} 次/秒）`);
  console.log(`  载荷总量：${(totals.msgBytes / 1024).toFixed(1)} KB`);
  console.log('\n【页面侧：渲染开销】');
  console.log(`  卡片重建次数：${last.cards}（每次重建 ${NOTE_COUNT} 张卡 = ${last.cards} 张卡被重建）`);
  console.log(`  缩略图重建次数：${last.imgs}`);
  console.log(`  长任务（>50ms）：${last.longTasks} 个，累计 ${Math.round(last.longTaskMs)}ms`);
  console.log(`  页面 evaluate 最长耗时：${pageEvalMax}ms`);
  if (last.stacks) { console.log('\n【网格重建调用栈】'); for (const st of last.stacks) console.log('  ', st); }

  console.log('\n【逐次采样】');
  console.log('   秒  search  changed   消息    卡片  缩略图  长任务  eval(ms)');
  for (const s of samples) {
    console.log(
      `  ${s.t.toFixed(1).padStart(4)}  ${String(s.search).padStart(6)}  ${String(s.changed).padStart(7)}  ${String(s.msgs).padStart(5)}  ${String(s.cards).padStart(5)}  ${String(s.imgs).padStart(6)}  ${String(s.longTasks).padStart(6)}  ${String(s.pageEvalMs).padStart(8)}`,
    );
  }

  cleanup();
}

main().catch((err) => {
  console.error('探针失败:', err);
  try {
    chrome?.kill();
  } catch {
    /* ignore */
  }
  process.exitCode = 1;
});
