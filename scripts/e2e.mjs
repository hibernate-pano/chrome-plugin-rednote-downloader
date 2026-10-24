/**
 * 端到端冒烟测试：用真实 Chrome 加载扩展，跑通「检测 → 面板 → 下载」链路。
 *
 * 用法：node scripts/e2e.mjs [noteUrl]
 * 前置：npm run build
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs, { mkdirSync, rmSync, readdirSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
const profile = `/tmp/rednote-e2e-profile-${process.pid}`;
// 用随机端口，避免连到上一次残留的实例
const port = 9400 + (process.pid % 400);
// Chrome 137+ 的正式版禁用了 --load-extension，测试需用 Chrome for Testing / Chromium
const CHROME_CANDIDATES = [
  path.join(
    process.env.HOME ?? '',
    'Library/Caches/ms-playwright/chromium-1248/chrome-mac-arm64',
    'Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
  ),
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
];

function resolveChrome() {
  for (const candidate of CHROME_CANDIDATES) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error('找不到可用的 Chrome');
}

const NOTE_URL =
  process.argv[2] ||
  'https://www.xiaohongshu.com/explore/6ab1a4190000000035013fcf?xsec_token=ABIo0V1NxZgz8-2-sAzqy7fdBwrNeiopmPCYHF5frw688=&xsec_source=pc_feed';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* --------------------------- CDP 客户端 --------------------------- */

class Cdp {
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

  send(method, params = {}, sessionId) {
    const id = ++this.id;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    this.ws.send(JSON.stringify(payload));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP 超时: ${method}`));
        }
      }, 30000);
    });
  }
}

async function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });
  return new Cdp(ws);
}

async function httpJson(url) {
  const res = await fetch(url);
  return res.json();
}

/* --------------------------- 主流程 --------------------------- */

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? '  ✅' : '  ❌'} ${name}${detail ? ` — ${detail}` : ''}`);
  return ok;
}

/** 递归列出目录下的文件 */
function walk(dir, out = [], depth = 0) {
  if (depth > 4) return out;
  let entries = [];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    // macOS 会在下载目录里塞 .DS_Store，它不是插件下载的文件
    if (entry === '.DS_Store') continue;
    const full = path.join(dir, entry);
    try {
      const st = statSync(full);
      if (st.isDirectory()) walk(full, out, depth + 1);
      else out.push(full);
    } catch {
      /* ignore */
    }
  }
  return out;
}

/**
 * 把扩展的下载方式切到「浏览器下载」。
 *
 * 未打包扩展的 ID 由**真实路径**派生（macOS 上 /tmp 是 /private/tmp 的软链）。
 */
async function useBrowserEngine() {
  const hex = createHash('sha256').update(fs.realpathSync(dist)).digest('hex').slice(0, 32);
  let extId = '';
  for (const c of hex) extId += String.fromCharCode(97 + parseInt(c, 16));

  let swTarget = null;
  for (let i = 0; i < 20; i += 1) {
    const list = await httpJson(`http://127.0.0.1:${port}/json/list`);
    swTarget = list.find(
      (t) => t.type === 'service_worker' && t.url.startsWith(`chrome-extension://${extId}/`),
    );
    if (swTarget) break;
    await sleep(300);
  }
  if (!swTarget) throw new Error('找不到 Service Worker target');

  const sw = await connect(swTarget.webSocketDebuggerUrl);
  await sw.send('Runtime.enable');
  await sw.send('Runtime.evaluate', {
    expression: `chrome.storage.local.set({'rednote.settings': {downloadMode: 'browser'}}).then(() => 'ok')`,
    returnByValue: true,
    awaitPromise: true,
  });
  console.log('▶ 已切到「浏览器下载」模式');
}

/** 浏览器下载目录里符合扩展命名规则的文件 */
function listDownloads() {
  const dir = path.join(process.env.HOME || '', 'Downloads');
  return walk(dir).filter((f) => /小红书下载/.test(f) && /\.(mp4|jpe?g|png|webp|m4v|mov)$/i.test(f));
}

let chromeProc = null;
process.on('exit', () => {
  try {
    chromeProc?.kill();
  } catch {
    /* ignore */
  }
});
process.on('SIGINT', () => {
  chromeProc?.kill();
  process.exit(130);
});

async function main() {
  rmSync(profile, { recursive: true, force: true });
  mkdirSync(profile, { recursive: true });

  console.log('▶ 启动 Chrome（加载扩展）…');
  const chrome = spawn(
    resolveChrome(),
    [
      `--user-data-dir=${profile}`,
      `--remote-debugging-port=${port}`,
      `--disable-extensions-except=${dist}`,
      `--load-extension=${dist}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--window-size=1440,900',
      'about:blank',
    ],
    { stdio: 'ignore', detached: false },
  );

  chromeProc = chrome;
  let targets = [];
  for (let i = 0; i < 60; i += 1) {
    try {
      targets = await httpJson(`http://127.0.0.1:${port}/json/list`);
      if (targets.length) break;
    } catch {
      /* 还没起来 */
    }
    await sleep(500);
  }
  if (!targets.length) {
    console.error('无法连接 Chrome 调试端口');
    chrome.kill();
    process.exit(1);
  }

  const page = targets.find((t) => t.type === 'page');
  const cdp = await connect(page.webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');

  // 这个脚本测的是「交给浏览器下载」那条路径（自研引擎由 e2e-self.mjs 覆盖）。
  await useBrowserEngine();

  const logs = [];
  cdp.ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data);
    if (msg.method === 'Runtime.consoleAPICalled') {
      logs.push({
        kind: msg.params.type,
        text: msg.params.args.map((a) => a.value ?? a.description).join(' '),
        urls: (msg.params.stackTrace?.callFrames ?? []).map((f) => f.url).filter(Boolean),
      });
    }
    if (msg.method === 'Runtime.exceptionThrown') {
      const d = msg.params.exceptionDetails ?? {};
      logs.push({
        kind: 'exception',
        text: `${d.text ?? ''} ${d.exception?.description ?? ''}`.trim(),
        urls: [d.url, ...(d.stackTrace?.callFrames ?? []).map((f) => f.url)].filter(Boolean),
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
      throw new Error(res.exceptionDetails.exception?.description || res.exceptionDetails.text);
    }
    return res.result.value;
  };

  console.log('▶ 打开笔记页…');
  await cdp.send('Page.navigate', { url: NOTE_URL });

  // 等扩展注入（轮询，最多 30s）
  let injected = null;
  for (let i = 0; i < 60; i += 1) {
    injected = await evaluate(`(() => {
      const host = document.querySelector('rednote-root');
      if (!host) return null;
      const sr = host.shadowRoot;
      const fab = sr && sr.querySelector('.rn-fab');
      return {
        ok: !!fab,
        badge: fab ? fab.querySelector('.rn-fab-badge')?.textContent : null,
        theme: host.getAttribute('data-theme'),
      };
    })()`);
    if (injected?.ok) break;
    await sleep(500);
  }

  const title = await evaluate('document.title');
  check('笔记页加载', !!title && !title.includes('不见了'), `title=${title}`);

  // 笔记页被重定向到登录墙 —— 这是站点策略变了或者链接的 token 过期了，
  // 不是扩展的毛病。直接说清楚，别让后面一堆看不懂的失败误导人。
  const path = await evaluate('location.pathname');
  if (String(path).startsWith('/login')) {
    console.log(
      '\n⚠️  站点把笔记页重定向到了登录墙（/login）。\n' +
        '    小红书现在要求登录才能看笔记详情 —— 这条测试需要一条当前有效的笔记链接，\n' +
        '    或者一个已登录的浏览器。跟扩展代码无关。\n' +
        `    当前链接：${NOTE_URL}\n`,
    );
    const skipped = results.filter((r) => !r.ok).length;
    console.log(`═══ 结果：${results.length - skipped}/${results.length} 通过（登录墙，跳过其余断言）═══`);
    await cdp.send('Browser.close').catch(() => undefined);
    process.exitCode = 0;
    return;
  }

  // 1. 扩展是否注入
  check('扩展已注入并渲染 FAB', Boolean(injected?.ok), JSON.stringify(injected));

  // 2. 打开面板
  await evaluate(`
    (() => {
      const sr = document.querySelector('rednote-root').shadowRoot;
      sr.querySelector('.rn-fab').click();
      return true;
    })()
  `);

  // 3. 等识别结果（站点数据要等页面脚本写入，扩展会重试）
  let detected = null;
  for (let i = 0; i < 40; i += 1) {
    detected = await evaluate(`
      (() => {
        const sr = document.querySelector('rednote-root').shadowRoot;
        const panel = sr.querySelector('.rn-panel');
        const rows = [...sr.querySelectorAll('.rn-row')].map(r => ({
          name: r.querySelector('.rn-row-name')?.textContent,
          meta: r.querySelector('.rn-row-meta')?.textContent,
          kind: r.dataset.kind,
        }));
        return {
          open: panel.dataset.open,
          headTitle: panel.querySelector('.rn-head-title')?.textContent,
          headSub: panel.querySelector('.rn-head-sub')?.textContent,
          sections: [...sr.querySelectorAll('.rn-section-head')].map(h => h.textContent.trim()),
          rows,
          footerTitle: panel.querySelector('.rn-footer-title')?.textContent,
          footerBtns: [...panel.querySelectorAll('.rn-footer .rn-btn')].map(b => b.textContent.trim()),
        };
      })()
    `);
    if ((detected.rows || []).length > 0) break;
    await sleep(500);
  }

  check('面板已展开', detected.open === 'true', `open=${detected.open}`);
  check(
    '识别到媒体资源',
    (detected.rows || []).length > 0,
    `sections=${JSON.stringify(detected.sections)} rows=${JSON.stringify(detected.rows)}`,
  );

  /* 标题识别：小红书有一部分笔记的 title 是空串，
     以前会退化成笔记编号（一串数字），这里盯着别回退 */
  const NOTE_ID = '6ab1a4190000000035013fcf';
  check(
    '笔记标题识别正常（不是编号、不是空）',
    Boolean(detected.headTitle) &&
      detected.headTitle !== '当前页面' &&
      !detected.headTitle.includes(NOTE_ID) &&
      !/^\d{6,}$/.test(detected.headTitle),
    `headTitle=${JSON.stringify(detected.headTitle)}`,
  );
  check(
    '文件名里没有笔记编号',
    (detected.rows || []).every((r) => !String(r.name || '').includes(NOTE_ID)),
    `rows=${JSON.stringify((detected.rows || []).map((r) => r.name))}`,
  );

  if ((detected.rows || []).length === 0) {
    console.log('   面板快照:', JSON.stringify(detected));
  }

  // 4. 直链可用性（用扩展算出来的链接，而不是重新推导）
  const linkProbe = await evaluate(`
    (async () => {
      const sr = document.querySelector('rednote-root').shadowRoot;
      const rows = [...sr.querySelectorAll('.rn-row')];
      const links = [];
      for (const row of rows) {
        const copy = row.querySelector('[data-action="copy"], .rn-row-copy');
        if (copy) links.push(copy.dataset.url || '');
      }
      return links;
    })()
  `);

  // 5. 触发真实下载（走扩展 chrome.downloads）——把每一行都点一遍
  const before = listDownloads();
  // 等按钮真的在面板里再点 —— 面板重建时按钮会短暂消失，
  // 那时候点下去等于什么都没发生（这正是要防的静默无响应）
  let btnCount = 0;
  for (let i = 0; i < 30; i += 1) {
    btnCount = await evaluate(
      `document.querySelector('rednote-root')?.shadowRoot?.querySelectorAll('.rn-row .rn-btn').length ?? 0`,
    );
    if (btnCount > 0) break;
    await sleep(300);
  }
  check('下载按钮在面板里', btnCount > 0, `按钮数=${btnCount}`);

  const clicked = await evaluate(`
    (() => {
      const sr = document.querySelector('rednote-root').shadowRoot;
      const btns = [...sr.querySelectorAll('.rn-row .rn-btn')];
      btns.forEach((b) => b.click());
      return btns.length;
    })()
  `);
  check('点击了下载按钮', clicked > 0, `点击=${clicked}`);
  await sleep(500);
  const toastAfterClick = await evaluate(`
    (() => {
      const sr = document.querySelector('rednote-root').shadowRoot;
      return [...sr.querySelectorAll('.rn-toast')].map(t => t.textContent);
    })()
  `);
  console.log('   点击按钮数=', clicked, ' 点击后 toast=', JSON.stringify(toastAfterClick));

  // 6. 进度反馈：在下载过程中抓一次行状态
  let progressUi = null;
  for (let i = 0; i < 24; i += 1) {
    progressUi = await evaluate(`
      (() => {
        const sr = document.querySelector('rednote-root').shadowRoot;
        const row = sr.querySelector('.rn-row');
        return {
          state: row ? row.dataset.state : null,
          hasBar: !!sr.querySelector('.rn-row-bar'),
          pct: sr.querySelector('.rn-row-pct')?.textContent || null,
          footer: sr.querySelector('.rn-footer-title')?.textContent || null,
        };
      })()
    `);
    if (progressUi.state === 'completed' || progressUi.state === 'failed') break;
    await sleep(400);
  }
  console.log('   进度 UI:', JSON.stringify(progressUi));

  // 落盘是异步的（UI 显示完成 ≠ 文件已经写完），所以轮询而不是死等
  let fresh = [];
  for (let i = 0; i < 40; i += 1) {
    await sleep(500);
    fresh = listDownloads().filter((f) => !before.includes(f));
    if (fresh.length > 0) break;
  }
  if (fresh.length === 0) {
    // 失败时把真实状态吐出来，别只报「新增 0 个」
    const rowState = await evaluate(`
      (() => {
        const sr = document.querySelector('rednote-root')?.shadowRoot;
        return [...sr.querySelectorAll('.rn-row')].map(r => ({
          name: r.querySelector('.rn-row-name')?.textContent,
          state: r.dataset.state,
          meta: r.querySelector('.rn-row-meta')?.textContent,
        }));
      })()
    `);
    const partial = walk(path.join(process.env.HOME || '', 'Downloads'))
      .filter((f) => f.includes('小红书下载'))
      .map((f) => `${path.basename(f)}(${statSync(f).size}B)`);
    console.log('   失败现场 rows=', JSON.stringify(rowState.rows ?? rowState), ' toast=', JSON.stringify(rowState.toast ?? []), ' files=', JSON.stringify(partial));
    const extLogs = logs.filter(
      (l) =>
        l.urls.some((u) => String(u).includes('chrome-extension')) ||
        /establish|receiving end|Uncaught|sendMessage/i.test(l.text),
    );
    console.log('   扩展相关日志:', JSON.stringify(extLogs.slice(0, 8), null, 1));
    // 直接问 Service Worker：下载到底有没有被创建
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const sw = list.find((t) => String(t.url || '').startsWith('chrome-extension://')) ||
        list.find((t) => t.type === 'service_worker');
      if (sw) {
        const swWs = new WebSocket(sw.webSocketDebuggerUrl);
        await new Promise((r) => swWs.addEventListener('open', r, { once: true }));
        const swId = { v: 0 };
        const swPend = new Map();
        swWs.addEventListener('message', (e) => {
          const m = JSON.parse(e.data);
          if (m.id && swPend.has(m.id)) {
            swPend.get(m.id)(m.result);
            swPend.delete(m.id);
          }
        });
        const swSend = (method, params = {}) => {
          const id = ++swId.v;
          swWs.send(JSON.stringify({ id, method, params }));
          return new Promise((r) => swPend.set(id, r));
        };
        const swRes = await swSend('Runtime.evaluate', {
          expression: `(async()=>JSON.stringify((await chrome.downloads.search({limit:5})).map(d=>({id:d.id,state:d.state,error:d.error,filename:d.filename,bytes:d.bytesReceived||0}))))()`,
          awaitPromise: true,
          returnByValue: true,
        });
        console.log('   SW downloads.search raw:', JSON.stringify(swRes).slice(0, 700));
        const sess = await swSend('Runtime.evaluate', {
          expression: `(async()=>JSON.stringify(await chrome.storage.session.get(null)))()`,
          awaitPromise: true,
          returnByValue: true,
        });
        console.log('   SW storage.session raw:', JSON.stringify(sess).slice(0, 700));
        swWs.close();
      } else {
        console.log('   SW 未启动（没有 service_worker target）');
      }
    } catch (e) {
      console.log('   SW 诊断失败:', String(e).slice(0, 200));
    }
  }
  check(
    '点击下载后文件落盘',
    fresh.length > 0,
    `新增 ${fresh.length} 个：${fresh.map((f) => path.basename(f)).join(', ')}`,
  );
  check(
    '落盘文件带扩展名且非空',
    fresh.length > 0 && fresh.every((f) => /\.[a-z0-9]{2,5}$/i.test(f) && statSync(f).size > 1024),
    fresh.map((f) => `${path.basename(f)}=${statSync(f).size}B`).join(', '),
  );

  /* ------------------------------------------------------------------ */
  /* 文件类型筛选（只下载视频 / 只下载图片）                             */
  /* ------------------------------------------------------------------ */

  console.log('▶ 测文件类型筛选…');

  const filterTabs = await evaluate(`
    (() => {
      const sr = document.querySelector('rednote-root').shadowRoot;
      return [...sr.querySelectorAll('.rn-tab-media')].map(t => ({
        label: t.textContent.trim(),
        selected: t.getAttribute('aria-selected'),
      }));
    })()
  `);
  check(
    '面板里有文件类型筛选（全部/视频/图片）',
    (filterTabs || []).length === 3 &&
      (filterTabs || []).map((t) => t.label).join(',') === '全部,视频,图片',
    `tabs=${JSON.stringify(filterTabs)}`,
  );

  const pickMediaTab = async (label) => {
    await evaluate(`
      (() => {
        const sr = document.querySelector('rednote-root').shadowRoot;
        const tab = [...sr.querySelectorAll('.rn-tab-media')].find(t => t.textContent.trim() === '${label}');
        if (tab) tab.click();
        return true;
      })()
    `);
    await sleep(600);
    return evaluate(`
      (() => {
        const sr = document.querySelector('rednote-root').shadowRoot;
        return {
          kinds: [...sr.querySelectorAll('.rn-row')].map(r => r.dataset.kind),
          sections: [...sr.querySelectorAll('.rn-section-head')].map(h => h.textContent.trim()),
          footer: sr.querySelector('.rn-footer-title')?.textContent || '',
          empty: /当前筛选下没有可下载的文件/.test(sr.querySelector('.rn-body')?.textContent || ''),
          selected: [...sr.querySelectorAll('.rn-tab-media')]
            .filter(t => t.getAttribute('aria-selected') === 'true')
            .map(t => t.textContent.trim()),
        };
      })()
    `);
  };

  const videoOnly = await pickMediaTab('视频');
  check(
    '切到「只下载视频」后列表里只剩视频',
    videoOnly.kinds.length === 0 ? videoOnly.empty : videoOnly.kinds.every((k) => k === 'video'),
    `kinds=${JSON.stringify(videoOnly.kinds)} sections=${JSON.stringify(videoOnly.sections)} empty=${videoOnly.empty}`,
  );
  check(
    '筛选状态高亮在「视频」',
    (videoOnly.selected || []).join(',') === '视频',
    `selected=${JSON.stringify(videoOnly.selected)}`,
  );

  const imageOnly = await pickMediaTab('图片');
  check(
    '切到「只下载图片」后列表里只剩图片',
    imageOnly.kinds.length === 0
      ? imageOnly.empty
      : imageOnly.kinds.every((k) => k === 'image'),
    `kinds=${JSON.stringify(imageOnly.kinds)} empty=${imageOnly.empty}`,
  );

  const backToAll = await pickMediaTab('全部');
  check(
    '切回「全部」后内容恢复',
    backToAll.kinds.length === 0 || backToAll.kinds.length >= videoOnly.kinds.length,
    `kinds=${JSON.stringify(backToAll.kinds)}`,
  );

  /* ------------------------------------------------------------------ */
  /* 保存结构（按笔记 / 按作者 / 全部平铺）                              */
  /* ------------------------------------------------------------------ */

  console.log('▶ 测保存结构…');

  const structureTabs = await evaluate(`
    (() => {
      const sr = document.querySelector('rednote-root').shadowRoot;
      return [...sr.querySelectorAll('.rn-tab-structure')].map(t => ({
        label: t.textContent.trim(),
        selected: t.getAttribute('aria-selected'),
      }));
    })()
  `);
  check(
    '面板里有保存结构页签（按笔记/按作者/全部平铺）',
    (structureTabs || []).length === 3 &&
      (structureTabs || []).map((t) => t.label).join(',') === '按笔记,按作者,全部平铺',
    `tabs=${JSON.stringify(structureTabs)}`,
  );

  await evaluate(`
    (() => {
      const sr = document.querySelector('rednote-root').shadowRoot;
      const tab = [...sr.querySelectorAll('.rn-tab-structure')].find(t => t.textContent.trim() === '按作者');
      if (tab) tab.click();
      return true;
    })()
  `);
  await sleep(700);

  const perAuthorState = await evaluate(`
    (() => {
      const sr = document.querySelector('rednote-root').shadowRoot;
      return {
        selected: [...sr.querySelectorAll('.rn-tab-structure')]
          .filter(t => t.getAttribute('aria-selected') === 'true')
          .map(t => t.textContent.trim()),
        rows: [...sr.querySelectorAll('.rn-row-name')].map(r => r.textContent.trim()),
      };
    })()
  `);
  check(
    '切到「按作者」后该页签被选中',
    (perAuthorState.selected || []).join(',') === '按作者',
    `selected=${JSON.stringify(perAuthorState.selected)}`,
  );
  check(
    '按作者分文件夹：文件名带标题，不再是裸序号',
    (perAuthorState.rows || []).length > 0 &&
      (perAuthorState.rows || []).every((n) => !/^\d+\.\w{2,5}$/.test(n)),
    `rows=${JSON.stringify(perAuthorState.rows)}`,
  );

  await evaluate(`
    (() => {
      const sr = document.querySelector('rednote-root').shadowRoot;
      const tab = [...sr.querySelectorAll('.rn-tab-structure')].find(t => t.textContent.trim() === '全部平铺');
      if (tab) tab.click();
      return true;
    })()
  `);
  await sleep(700);

  const flatState = await evaluate(`
    (() => {
      const sr = document.querySelector('rednote-root').shadowRoot;
      return {
        selected: [...sr.querySelectorAll('.rn-tab-structure')]
          .filter(t => t.getAttribute('aria-selected') === 'true')
          .map(t => t.textContent.trim()),
        rows: [...sr.querySelectorAll('.rn-row-name')].map(r => r.textContent.trim()),
      };
    })()
  `);
  check(
    '切到「全部平铺」后该页签被选中',
    (flatState.selected || []).join(',') === '全部平铺',
    `selected=${JSON.stringify(flatState.selected)}`,
  );
  check(
    '全部平铺：文件名带标题，不再是裸序号',
    (flatState.rows || []).length > 0 &&
      (flatState.rows || []).every((n) => !/^\d+\.\w{2,5}$/.test(n)),
    `rows=${JSON.stringify(flatState.rows)}`,
  );

  // 切回默认的「按笔记」，别把设置留在测试状态
  await evaluate(`
    (() => {
      const sr = document.querySelector('rednote-root').shadowRoot;
      const tab = [...sr.querySelectorAll('.rn-tab-structure')].find(t => t.textContent.trim() === '按笔记');
      if (tab) tab.click();
      return true;
    })()
  `);
  await sleep(500);

  // 7. 扩展自身的控制台错误（站点自己的报错不算）
  const extensionErrors = logs.filter(
    (l) =>
      (l.kind === 'error' || l.kind === 'exception') &&
      l.urls.some((u) => String(u).startsWith('chrome-extension://')),
  );
  check(
    '扩展无运行时报错',
    extensionErrors.length === 0,
    extensionErrors
      .slice(0, 3)
      .map((e) => e.text.slice(0, 200))
      .join(' | '),
  );

  /* ------------------------------------------------------------------ */
  /* 主页批量入口                                                       */
  /* ------------------------------------------------------------------ */

  console.log('▶ 打开作者主页（游客态）…');

  // 从笔记页取作者主页链接（必须带 xsec_token，否则会被重定向回首页）
  const profileUrl = await evaluate(`
    (() => {
      const a = document.querySelector('a[href*="/user/profile/"]');
      return a ? a.href : null;
    })()
  `);

  if (!profileUrl) {
    check('能取到作者主页链接', false, '页面里没有 /user/profile/ 链接');
  } else {
    check('能取到作者主页链接', true, profileUrl.slice(0, 90));

    await cdp.send('Page.navigate', { url: profileUrl });
    await sleep(6000);

    // 等扩展重新注入
    let injectedOnProfile = false;
    for (let i = 0; i < 40; i += 1) {
      injectedOnProfile = await evaluate(
        `!!document.querySelector('rednote-root')?.shadowRoot?.querySelector('.rn-fab')`,
      );
      if (injectedOnProfile) break;
      await sleep(500);
    }
    check('主页页扩展已注入', Boolean(injectedOnProfile));

    // 点 FAB —— 主页上这一步是「直接开始扫描」
    await evaluate(`
      (() => {
        const sr = document.querySelector('rednote-root').shadowRoot;
        sr.querySelector('.rn-fab').click();
        return true;
      })()
    `);

    // 等扫描结束（面板不再显示「正在扫描」）
    let profileState = null;
    for (let i = 0; i < 60; i += 1) {
      profileState = await evaluate(`
        (() => {
          const sr = document.querySelector('rednote-root').shadowRoot;
          const panel = sr.querySelector('.rn-panel');
          return {
            open: panel?.dataset.open,
            headSub: panel?.querySelector('.rn-head-sub')?.textContent || '',
            bodyText: (panel?.querySelector('.rn-body')?.textContent || '').slice(0, 300),
            buttons: [...(panel?.querySelectorAll('.rn-state-actions .rn-btn') || [])].map(b => b.textContent.trim()),
            footerBtns: [...(panel?.querySelectorAll('.rn-footer .rn-btn') || [])].map(b => b.textContent.trim()),
          };
        })()
      `);
      if (profileState?.bodyText && !/正在扫描/.test(profileState.bodyText)) break;
      await sleep(600);
    }

    check(
      '主页模式：面板给出明确状态而不是空白',
      Boolean(profileState?.bodyText && profileState.bodyText.trim().length > 0),
      `headSub=${profileState?.headSub}`,
    );

    // 游客态拿不到笔记 id —— 必须如实说明并给登录入口，不能静默空白
    const mentionsLogin =
      /登录/.test(profileState?.bodyText || '') || /登录/.test(profileState?.headSub || '');
    const hasLoginBtn = (profileState?.buttons || []).some((b) => /登录/.test(b));
    check(
      '游客态明确告知需要登录并给出入口',
      mentionsLogin && hasLoginBtn,
      `body="${(profileState?.bodyText || '').replace(/\s+/g, ' ').slice(0, 140)}" buttons=${JSON.stringify(profileState?.buttons)}`,
    );
  }

  console.log('\n▶ 关闭 Chrome');
  chrome.kill();
  await sleep(500);

  const failed = results.filter((r) => !r.ok);
  console.log(`\n═══ 结果：${results.length - failed.length}/${results.length} 通过 ═══`);
  if (failed.length) {
    for (const f of failed) console.log(`  ❌ ${f.name} — ${f.detail}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('测试失败:', err);
  chromeProc?.kill();
  process.exit(1);
});
