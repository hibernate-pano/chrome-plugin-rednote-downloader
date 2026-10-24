/**
 * 主页批量下载的端到端测试。
 *
 * 难点：批量扫描需要登录态，而测试不能碰用户的账号。
 * 解法：起一个本地假站点，用 --host-resolver-rules 把 www.xiaohongshu.com
 * 指到它上面。扩展照常注入，数据形状照抄真实的小红书接口响应
 * （user_posted 的 notes[]、笔记页的 noteDetailMap），媒体地址用真实的 CDN 直链，
 * 所以「扫描 → 勾选 → 解析 → 下载 → 落盘」整条链路是真的在跑。
 *
 * 运行：node scripts/e2e-batch.mjs
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
const profileDir = `/tmp/rednote-e2e-batch-${process.pid}`;
const port = 9700 + (process.pid % 200);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const CHROME_CANDIDATES = [
  `${process.env.HOME}/Library/Caches/ms-playwright/chromium-1248/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`,
  `${process.env.HOME}/Library/Caches/ms-playwright/chromium-1194/chrome-mac/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
];

function resolveChrome() {
  for (const p of CHROME_CANDIDATES) if (fs.existsSync(p)) return p;
  throw new Error('找不到可用的 Chrome');
}

/* ------------------------------------------------------------------ */
/* 假数据（形状照抄真实响应，媒体地址用真实 CDN）                        */
/* ------------------------------------------------------------------ */

const IMAGE_FILE_ID = '1040g2sg325d5f1ni4q005n341tr4na22ndh5mg8';
const IMAGE_PREVIEW =
  'https://sns-webpic-qc.xhscdn.com/202610241249/036c3b98f180befdb20ada1f779c0111/' +
  IMAGE_FILE_ID +
  '!nd_dft_wlteh_webp_3';
const VIDEO_URL =
  'https://sns-bak-v1.xhscdn.com/stream/79/110/258/01eab1a3bcc06cc24f037001a0c5e9440a_258.mp4';

const AUTHOR = 'mockauthor';

const NOTES = [
  {
    id: 'mocknote0001',
    token: 'mock-token-video',
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
    id: 'mocknote0002',
    token: 'mock-token-image-1',
    type: 'normal',
    title: '图集笔记一',
    images: [{ fileId: IMAGE_FILE_ID, width: 1440, height: 1921 }],
  },
  {
    id: 'mocknote0003',
    token: 'mock-token-image-2',
    type: 'normal',
    title: '图集笔记二',
    images: [{ fileId: IMAGE_FILE_ID, width: 1440, height: 1921 }],
  },
];

function noteDetail(note) {
  return {
    noteId: note.id,
    type: note.type,
    title: note.title,
    desc: '这是假站点的测试数据',
    user: { nickname: AUTHOR, userId: 'mockuser0001' },
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

/** 主页的 __INITIAL_STATE__ —— 形状对齐真实 user_posted 响应 */
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

/* ------------------------------------------------------------------ */
/* 假站点                                                              */
/* ------------------------------------------------------------------ */

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
  })};</script>
</head><body><div id="app"></div></body></html>`;
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

function walk(dir, out = []) {
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    // macOS 会在下载目录里塞 .DS_Store，它不是插件下载的文件
    if (entry.name === '.DS_Store') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

function downloadRoot() {
  return path.join(process.env.HOME || '', 'Downloads', '小红书下载');
}

async function main() {
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    res.setHeader('content-type', 'text/html; charset=utf-8');
    if (url.pathname.startsWith('/user/profile/')) {
      res.end(profileHtml());
      return;
    }
    const explore = url.pathname.match(/^\/explore\/([A-Za-z0-9_-]+)/);
    if (explore) {
      const note = NOTES.find((n) => n.id === explore[1]);
      if (note) {
        res.end(noteHtml(note));
        return;
      }
    }
    res.end('<!doctype html><html><body>ok</body></html>');
  });

  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  console.log(`▶ 假站点已启动：http://127.0.0.1:${port}`);

  // 测试专用构建：复制一份 dist，给 content script 加上本地 origin 的匹配。
  // 交付用的 dist/ 完全不受影响。
  const testDist = path.join(profileDir, 'dist');
  fs.cpSync(dist, testDist, { recursive: true });
  const manifestPath = path.join(testDist, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const origin = `http://127.0.0.1:${port}`;
  for (const cs of manifest.content_scripts) cs.matches.push(`${origin}/*`);
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

  const chrome = spawn(
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
    chrome.kill();
    server.close();
    try {
      fs.rmSync(profileDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  };

  try {
    await sleep(5000);
    const targets = await (await fetch(`http://127.0.0.1:${port + 500}/json/list`)).json();
    const page = targets.find((t) => t.type === 'page');
    if (!page) throw new Error('找不到页面 target');

    const cdp = await connect(page.webSocketDebuggerUrl);
    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');
    await cdp.send('Network.enable');

    const logs = [];
    cdp.on((msg) => {
      if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
        logs.push({
          kind: 'error',
          text: (msg.params.args || []).map((a) => a.value ?? a.description ?? '').join(' '),
          urls: [],
        });
      }
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

    console.log('▶ 打开假的主页…');
    await cdp.send('Page.navigate', {
      url: `${origin}/user/profile/mockuser0001?xsec_token=mock`,
    });

    // 等扩展注入
    let injected = false;
    for (let i = 0; i < 40; i += 1) {
      injected = await evaluate(
        `!!document.querySelector('rednote-root')?.shadowRoot?.querySelector('.rn-fab')`,
      );
      if (injected) break;
      await sleep(400);
    }
    check('扩展已注入', Boolean(injected));

    // 只点一次 FAB（主页上这一步 = 直接开始扫描）
    await evaluate(`
      (() => {
        const sr = document.querySelector('rednote-root').shadowRoot;
        sr.querySelector('.rn-fab').click();
        return true;
      })()
    `);

    // 等扫描完成
    let vm = null;
    for (let i = 0; i < 60; i += 1) {
      vm = await evaluate(`
        (() => {
          const sr = document.querySelector('rednote-root')?.shadowRoot;
          if (!sr) return null;
          const panel = sr.querySelector('.rn-panel');
          return {
            headSub: panel?.querySelector('.rn-head-sub')?.textContent || '',
            cards: [...sr.querySelectorAll('.rn-card')].map(c => ({
              title: c.querySelector('.rn-card-title')?.textContent,
              chip: c.querySelector('.rn-chip')?.textContent,
              selected: c.dataset.selected,
            })),
            tabs: [...sr.querySelectorAll('.rn-tab:not(.rn-tab-media):not(.rn-tab-structure)')].map(t => t.textContent.trim()),
            mediaTabs: [...sr.querySelectorAll('.rn-tab-media')].map(t => t.textContent.trim()),
            structureTabs: [...sr.querySelectorAll('.rn-tab-structure')].map(t => t.textContent.trim()),
            scanning: /正在扫描/.test(panel?.querySelector('.rn-body')?.textContent || ''),
          };
        })()
      `);
      if (vm && vm.cards.length > 0 && !vm.scanning) break;
      await sleep(600);
    }

    if (!vm || vm.cards.length === 0) {
      // 兜底：直接从页面问一次 RPC，看是扩展没拿到数据还是 UI 没渲染
      const probe = await evaluate(`
        (() => {
          const ch = document.documentElement.getAttribute('data-rednote-channel');
          if (!ch) return 'no-channel';
          window.__probe = null;
          window.addEventListener('message', (e) => {
            const d = e.data;
            if (d && d.__rednote === ch && d.id === 'probe') window.__probe = d;
          });
          window.postMessage({__rednote: ch, id: 'probe', method: 'state.userNotes', params: {}}, '*');
          return 'sent';
        })()
      `);
      await sleep(1500);
      const probeResp = await evaluate('JSON.stringify(window.__probe)');
      console.log('   RPC 探针:', probe, probeResp);
    }

    check('主页扫描出卡片', (vm?.cards || []).length === 3, `cards=${JSON.stringify(vm?.cards)}`);
    check(
      '分类计数正确（视频 1 / 图集 2）',
      /视频\s*1/.test(vm?.headSub || '') && /图集\s*2/.test(vm?.headSub || ''),
      `headSub=${vm?.headSub}`,
    );
    check(
      '筛选页签带数量',
      (vm?.tabs || []).length === 3 && (vm?.tabs || []).every((t) => /\d/.test(t)),
      `tabs=${JSON.stringify(vm?.tabs)}`,
    );
    check(
      '有文件类型筛选（全部/视频/图片）',
      (vm?.mediaTabs || []).join(',') === '全部,视频,图片',
      `mediaTabs=${JSON.stringify(vm?.mediaTabs)}`,
    );

    // 全选 → 取消全选 → 再全选
    await evaluate(`
      (() => {
        const sr = document.querySelector('rednote-root').shadowRoot;
        const btn = [...sr.querySelectorAll('.rn-toolbar-right .rn-btn')].find(b => /全选/.test(b.textContent));
        btn.click();
        return true;
      })()
    `);
    await sleep(400);
    const afterSelect = await evaluate(`
      (() => {
        const sr = document.querySelector('rednote-root').shadowRoot;
        return {
          selected: [...sr.querySelectorAll('.rn-card')].filter(c => c.dataset.selected === 'true').length,
          footer: sr.querySelector('.rn-footer-title')?.textContent,
          startBtn: sr.querySelector('.rn-footer .rn-btn[data-variant="primary"]')?.textContent.trim(),
        };
      })()
    `);
    check('全选生效', afterSelect.selected === 3, `selected=${afterSelect.selected} footer=${afterSelect.footer}`);
    check(
      '主按钮带数量',
      /3/.test(afterSelect.startBtn || ''),
      `startBtn=${afterSelect.startBtn}`,
    );

    // 取消全选 → 再全选
    await evaluate(`
      (() => {
        const sr = document.querySelector('rednote-root').shadowRoot;
        const btn = [...sr.querySelectorAll('.rn-toolbar-right .rn-btn')].find(b => /取消全选/.test(b.textContent));
        btn.click();
        return true;
      })()
    `);
    await sleep(300);
    const afterUnselect = await evaluate(`
      (() => {
        const sr = document.querySelector('rednote-root').shadowRoot;
        return [...sr.querySelectorAll('.rn-card')].filter(c => c.dataset.selected === 'true').length;
      })()
    `);
    check('取消全选生效', afterUnselect === 0, `selected=${afterUnselect}`);

    // 取消全选后只勾 2 条，验证「按需勾选」
    await evaluate(`
      (() => {
        const sr = document.querySelector('rednote-root').shadowRoot;
        const cards = [...sr.querySelectorAll('.rn-card')];
        cards[0].click();
        cards[1].click();
        return true;
      })()
    `);
    await sleep(300);
    const partial = await evaluate(`
      (() => {
        const sr = document.querySelector('rednote-root').shadowRoot;
        return {
          selected: [...sr.querySelectorAll('.rn-card')].filter(c => c.dataset.selected === 'true').length,
          footer: sr.querySelector('.rn-footer-title')?.textContent,
        };
      })()
    `);
    check('按需勾选生效', partial.selected === 2, `selected=${partial.selected} footer=${partial.footer}`);

    // 恢复全选，测完整批量下载
    await evaluate(`
      (() => {
        const sr = document.querySelector('rednote-root').shadowRoot;
        const btn = [...sr.querySelectorAll('.rn-toolbar-right .rn-btn')].find(b => /全选/.test(b.textContent));
        btn.click();
        return true;
      })()
    `);
    await sleep(300);

    const before = walk(downloadRoot());
    console.log('▶ 点「开始下载」，触发批量解析 + 下载…');
    await evaluate(`
      (() => {
        const sr = document.querySelector('rednote-root').shadowRoot;
        const btn = sr.querySelector('.rn-footer .rn-btn[data-variant="primary"]');
        btn.click();
        return true;
      })()
    `);

    // 解析过程应当有可见反馈
    let resolvingUi = null;
    for (let i = 0; i < 20; i += 1) {
      resolvingUi = await evaluate(`
        (() => {
          const sr = document.querySelector('rednote-root').shadowRoot;
          const panel = sr.querySelector('.rn-panel');
          return {
            headSub: panel?.querySelector('.rn-head-sub')?.textContent || '',
            footer: panel?.querySelector('.rn-footer-title')?.textContent || '',
            btn: panel?.querySelector('.rn-footer .rn-btn[data-variant="primary"]')?.textContent.trim() || '',
            resolving: /解析/.test(panel?.querySelector('.rn-footer')?.textContent || ''),
          };
        })()
      `);
      if (resolvingUi.resolving) break;
      await sleep(150);
    }
    check('解析过程有可见进度', Boolean(resolvingUi?.resolving), JSON.stringify(resolvingUi));

    // 等下载落盘。
    // 注意：Chrome 下一个正在下载的文件会先落成 xxx.crdownload，
    // 那不算下完 —— 数文件的时候必须把它排除，否则会在视频还没下完时就「达标」
    let after = before;
    let settled = false;
    for (let i = 0; i < 60; i += 1) {
      await sleep(700);
      after = walk(downloadRoot());
      const fresh = after.filter((f) => !before.includes(f) && !f.endsWith('.crdownload'));
      if (fresh.length >= 4) {
        settled = true;
        break;
      }
    }
    const fresh = after.filter((f) => !before.includes(f));

    check('批量文件全部落盘', settled && fresh.length === 4, `新增 ${fresh.length} 个：${fresh.map((f) => path.relative(downloadRoot(), f)).join(', ')}`);

    const byFolder = new Set(fresh.map((f) => path.basename(path.dirname(f))));
    check('每篇笔记独立文件夹', byFolder.size === 3, [...byFolder].join(' | '));

    const extOk = fresh.every((f) => /\.(mp4|jpg|jpeg|png|webp)$/i.test(f));
    const sizeOk = fresh.every((f) => fs.statSync(f).size > 1024);
    check('文件带扩展名且非空', extOk && sizeOk, fresh.map((f) => `${path.basename(f)}=${fs.statSync(f).size}B`).join(', '));

    const hasVideo = fresh.some((f) => f.endsWith('.mp4'));
    const hasImages = fresh.filter((f) => /\.(jpg|jpeg|png|webp)$/i.test(f)).length === 3;
    check('视频与图片都下载到了', hasVideo && hasImages, fresh.map((f) => path.basename(f)).join(', '));

    const extensionErrors = logs.filter((l) => l.kind === 'error' || l.kind === 'exception');
    check('扩展无运行时报错', extensionErrors.length === 0, extensionErrors.slice(0, 3).map((e) => e.text.slice(0, 200)).join(' | '));

    /* ------------------------------------------------------------------ */
    /* 第二轮：文件类型筛选 —— 只下载视频                                  */
    /* ------------------------------------------------------------------ */

    // 先把上一轮的文件清掉，否则重下的 mp4 会被 uniquify 成「1 (1).mp4」，数量对不上
    for (const dir of byFolder) {
      try {
        fs.rmSync(path.join(downloadRoot(), AUTHOR, dir), { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
    try {
      fs.rmSync(path.join(downloadRoot(), AUTHOR), { recursive: true, force: true });
    } catch {
      /* ignore */
    }

    console.log('▶ 切到「只下载视频」，再下载一次…');
    await evaluate(`
      (() => {
        const sr = document.querySelector('rednote-root').shadowRoot;
        const tab = [...sr.querySelectorAll('.rn-tab-media')].find(t => t.textContent.trim() === '视频');
        if (tab) tab.click();
        return true;
      })()
    `);
    await sleep(700);

    const filterState = await evaluate(`
      (() => {
        const sr = document.querySelector('rednote-root').shadowRoot;
        return {
          selected: [...sr.querySelectorAll('.rn-tab-media')]
            .filter(t => t.getAttribute('aria-selected') === 'true')
            .map(t => t.textContent.trim()),
          footerSub: sr.querySelector('.rn-footer-sub')?.textContent || '',
          cards: [...sr.querySelectorAll('.rn-card')].length,
        };
      })()
    `);
    check(
      '切到「只下载视频」后卡片列表不变（只影响下载，不影响展示）',
      filterState.cards === 3,
      `cards=${filterState.cards}`,
    );
    check(
      '底部说明当前只下载视频',
      (filterState.selected || []).join(',') === '视频' && /只下载视频/.test(filterState.footerSub),
      `selected=${JSON.stringify(filterState.selected)} footerSub=${filterState.footerSub}`,
    );

    const beforeVideo = walk(downloadRoot());
    await evaluate(`
      (() => {
        const sr = document.querySelector('rednote-root').shadowRoot;
        const btn = sr.querySelector('.rn-footer .rn-btn[data-variant="primary"]');
        btn.click();
        return true;
      })()
    `);

    // 等 mp4 真正落盘（.crdownload 是未完成的临时文件，不算数）
    let videoFresh = [];
    for (let i = 0; i < 90; i += 1) {
      await sleep(700);
      videoFresh = walk(downloadRoot())
        .filter((f) => !beforeVideo.includes(f))
        .filter((f) => !f.endsWith('.crdownload'));
      if (videoFresh.some((f) => f.endsWith('.mp4'))) break;
    }

    check(
      '只下载视频：只落盘 1 个 mp4，没有图片',
      videoFresh.length === 1 && videoFresh[0].endsWith('.mp4'),
      `新增 ${videoFresh.length} 个：${videoFresh.map((f) => path.basename(f)).join(', ')}`,
    );
    check(
      '只下载视频：没有落下任何图片',
      videoFresh.every((f) => !/\.(jpg|jpeg|png|webp)$/i.test(f)),
      videoFresh.map((f) => path.basename(f)).join(', '),
    );

    // 清理：只删本次测试产生的目录
    for (const dir of byFolder) {
      const full = path.join(downloadRoot(), AUTHOR, dir);
      try {
        fs.rmSync(full, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
    try {
      fs.rmSync(path.join(downloadRoot(), AUTHOR), { recursive: true, force: true });
    } catch {
      /* ignore */
    }

    /* ---------------------------------------------------------------- */
    /* 第三轮：切到「按作者分文件夹」再下载一次                            */
    /* ---------------------------------------------------------------- */

    // 上一轮把文件类型筛选留在了「只下载视频」，这轮要全量，先改回「全部」
    await evaluate(`
      (() => {
        const sr = document.querySelector('rednote-root').shadowRoot;
        const tab = [...sr.querySelectorAll('.rn-tab-media')].find(t => t.textContent.trim() === '全部');
        if (tab) tab.click();
        return true;
      })()
    `);
    await sleep(500);

    console.log('▶ 切到「按作者分文件夹」，再下载一次…');
    const structureState = await evaluate(`
      (() => {
        const sr = document.querySelector('rednote-root').shadowRoot;
        const tab = [...sr.querySelectorAll('.rn-tab-structure')].find(t => t.textContent.trim() === '按作者');
        if (tab) tab.click();
        return {
          tabs: [...sr.querySelectorAll('.rn-tab-structure')].map(t => t.textContent.trim()),
          selected: [...sr.querySelectorAll('.rn-tab-structure')]
            .filter(t => t.getAttribute('aria-selected') === 'true')
            .map(t => t.textContent.trim()),
        };
      })()
    `);
    check(
      '面板里有「按笔记 / 按作者 / 全部平铺」三个结构页签',
      (structureState.tabs || []).join(',') === '按笔记,按作者,全部平铺',
      `tabs=${JSON.stringify(structureState.tabs)}`,
    );
    check(
      '切到「按作者」后该页签被选中',
      (structureState.selected || []).join(',') === '按作者',
      `selected=${JSON.stringify(structureState.selected)}`,
    );
    await sleep(700);

    const beforePerAuthor = walk(downloadRoot());
    await evaluate(`
      (() => {
        const sr = document.querySelector('rednote-root').shadowRoot;
        const btn = sr.querySelector('.rn-footer .rn-btn[data-variant="primary"]');
        btn.click();
        return true;
      })()
    `);

    let perAuthorFresh = [];
    for (let i = 0; i < 90; i += 1) {
      await sleep(700);
      perAuthorFresh = walk(downloadRoot())
        .filter((f) => !beforePerAuthor.includes(f))
        .filter((f) => !f.endsWith('.crdownload'));
      if (perAuthorFresh.length >= 4) break;
    }

    check(
      '按作者分文件夹：文件落在以作者命名的目录里',
      perAuthorFresh.length === 4 &&
        perAuthorFresh.every((f) =>
          path.relative(downloadRoot(), f).startsWith(AUTHOR + path.sep),
        ),
      perAuthorFresh.map((f) => path.relative(downloadRoot(), f)).join(' | '),
    );
    check(
      '按作者分文件夹：目录里不再按笔记建子目录',
      perAuthorFresh.length > 0 &&
        perAuthorFresh.every(
          (f) => path.relative(downloadRoot(), f).split(path.sep).length === 2,
        ),
      perAuthorFresh.map((f) => path.relative(downloadRoot(), f)).join(' | '),
    );
    check(
      '按作者分文件夹：文件名带标题，不会一堆 1.jpg',
      perAuthorFresh.length > 0 &&
        perAuthorFresh.every((f) => !/^\d+\.(jpg|mp4)$/.test(path.basename(f))),
      perAuthorFresh.map((f) => path.basename(f)).join(' | '),
    );

    // 清理：只删本次测试产生的文件
    for (const f of perAuthorFresh) {
      try {
        fs.rmSync(f, { force: true });
      } catch {
        /* ignore */
      }
    }

    /* ---------------------------------------------------------------- */
    /* 第四轮：切到「全部平铺」再下载一次                                  */
    /* ---------------------------------------------------------------- */

    console.log('▶ 切到「全部平铺」，再下载一次…');
    await evaluate(`
      (() => {
        const sr = document.querySelector('rednote-root').shadowRoot;
        const tab = [...sr.querySelectorAll('.rn-tab-structure')].find(t => t.textContent.trim() === '全部平铺');
        if (tab) tab.click();
        return true;
      })()
    `);
    await sleep(700);

    const beforeFlat = walk(downloadRoot());
    await evaluate(`
      (() => {
        const sr = document.querySelector('rednote-root').shadowRoot;
        const btn = sr.querySelector('.rn-footer .rn-btn[data-variant="primary"]');
        btn.click();
        return true;
      })()
    `);

    let flatFresh = [];
    for (let i = 0; i < 90; i += 1) {
      await sleep(700);
      flatFresh = walk(downloadRoot())
        .filter((f) => !beforeFlat.includes(f))
        .filter((f) => !f.endsWith('.crdownload'));
      if (flatFresh.length >= 4) break;
    }

    check(
      '全部平铺：文件全部落在一个目录里',
      flatFresh.length === 4 &&
        flatFresh.every((f) => !path.relative(downloadRoot(), f).includes(path.sep)),
      flatFresh.map((f) => path.relative(downloadRoot(), f)).join(' | '),
    );
    check(
      '全部平铺：文件名带作者与标题，不会一堆 1.mp4',
      flatFresh.length > 0 &&
        flatFresh.every((f) => path.basename(f).includes(AUTHOR)) &&
        flatFresh.some((f) => path.basename(f).includes('视频笔记')),
      flatFresh.map((f) => path.basename(f)).join(' | '),
    );
    check(
      '全部平铺：没有再建作者/标题子目录',
      !flatFresh.some((f) => path.relative(downloadRoot(), f).startsWith(AUTHOR + path.sep)),
      flatFresh.map((f) => path.relative(downloadRoot(), f)).join(' | '),
    );

    // 清理：只删本次测试产生的文件
    for (const f of flatFresh) {
      try {
        fs.rmSync(f, { force: true });
      } catch {
        /* ignore */
      }
    }
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
