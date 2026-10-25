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

import { feedApiJson, makeRequestCounter, notePageHtml, serializeState, UNDEF } from './fake-site.mjs';
import { createHash } from 'node:crypto';
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

/**
 * 一条「坏」的视频直链（本地假站点上的 404）。
 *
 * 用来模拟「SSR 里那份直链是坏的 / 跟页面看到的不一样」。
 */
let BROKEN_VIDEO_URL = '';

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
  {
    // 详情里只有 id 和类型，没有媒体 ——
    // 模拟「状态先到、媒体后补」时拿到空壳的那种笔记。
    // 扩展必须把它判成解析失败，而不是「解析成功但一个视频都没有」。
    id: 'mocknote0004',
    token: 'mock-token-shell',
    type: 'video',
    title: '媒体还没补上的笔记',
    images: [],
    shell: true,
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
    // 空壳笔记（shell）：只有 id 和类型，没有媒体 ——
    // 模拟「状态先到、媒体后补」时拿到空壳的那种笔记。
    // 扩展必须把它判成解析失败，而不是「解析成功但一个视频都没有」。
    ...(note.shell
      ? {}
      : {
          imageList: note.images.map((img) => ({
            fileId: img.fileId,
            width: img.width,
            height: img.height,
            urlDefault: IMAGE_PREVIEW,
            url: '',
            infoList: [{ imageScene: 'WB_DFT', url: IMAGE_PREVIEW }],
          })),
        }),
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
    note: { firstNoteId: NOTES[0].id, noteDetailMap: {}, currentNoteId: UNDEF },
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
<script>window.__INITIAL_STATE__ = ${serializeState(profileState())};</script>
</head><body><div id="app"><div class="feeds-container">${cards}</div></div></body></html>`;
}

/**
 * 笔记页的 HTML。
 *
 * ssrDetail 决定「服务端渲染的 HTML 里有没有笔记详情」：
 *   true  —— 有。扩展的「抓 HTML」快路能走通，一条笔记都不开 iframe。
 *   false —— 没有（真站点未登录时就是这样：详情是页面 JS 用 XHR 拉的）。
 *            扩展必须退回 iframe，而且**只能多花一次抓取**，
 *            不能给每条笔记都白打一遍。
 *
 * detailPath 决定「详情放在状态里的哪个位置」：
 *   'noteDetailMap' —— 常见形状。
 *   'currentNote'   —— 站点改版，详情挪到了别的地方。
 *                       扩展必须照样找得到（位置变了不等于解析不出来了）。
 *
 * viaApi 决定「详情是不是只从接口来」：
 *   true —— 页面自己 XHR 一次接口拿详情，而且**不写进状态**。
 *           扩展只能从抓到的接口响应里把笔记找出来。
 *
 * viaApiXhr 跟 viaApi 一样，但用 **XHR + responseType: 'json'**（axios 那种）。
 *   真站点就是这么发的；这种请求读 xhr.responseText 会抛，
 *   扩展要是只读 responseText，这条路就断了。
 *
 * mediaOverride 用来改写详情里的媒体直链 ——
 * 模拟「SSR 里那份跟页面渲染那份不是同一个东西」（真站点上完全可能：
 * SSR 少几个字段、地址是旧的、直链是坏的）。
 */
function noteHtml(
  note,
  ssrDetail = true,
  mediaOverride = null,
  detailPath = 'noteDetailMap',
  viaApi = false,
  viaApiXhr = false,
) {
  const detail = noteDetail(note);
  if (mediaOverride) mediaOverride(detail);
  return notePageHtml({ note, detail, ssrDetail, detailPath, viaApi, viaApiXhr });
}

/**
 * 把详情里的视频直链换成一条坏地址。
 *
 * 用来验证扩展的判断对不对：
 * 页面渲染出来的那条直链是好的，SSR 里那条是坏的 ——
 * 扩展必须下页面那份（好），不能下 SSR 那份（坏）。
 *
 * **只能替换，不能就地改**：`h264` 数组里放的是 NOTES 里那条共享的 note.video，
 * 就地改会把坏地址永久留在假站点的数据里 ——
 * 后面几轮（哪怕已经把 ssrMediaDiffers 关掉了）也照样拿到坏地址，
 * 测出来「扩展下了坏的直链」，其实坏的是假站点自己。
 */
function breakVideoUrl(detail) {
  const h264 = detail.video?.media?.stream?.h264;
  if (!Array.isArray(h264) || h264.length === 0) return;
  h264[0] = { ...h264[0], masterUrl: BROKEN_VIDEO_URL, backupUrls: [BROKEN_VIDEO_URL] };
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

/**
 * 这一轮新落盘的文件。
 *
 * 按「落盘时间」算，不按「跟上一轮比」——
 * 文件名是按笔记内容生成的，每一轮都一样，
 * 所以上一轮要是没清干净，「跟上一轮比」就永远算不出新增，
 * 测出来是「一条都没下」，其实文件早就在那儿了。
 */
function freshSince(dir, sinceMs) {
  return walk(dir).filter((f) => {
    if (f.endsWith('.crdownload')) return false;
    try {
      return fs.statSync(f).mtimeMs >= sinceMs;
    } catch {
      return false;
    }
  });
}

/**
 * 把扩展的下载方式切到「浏览器下载」。
 *
 * 未打包扩展的 ID 由**真实路径**派生（macOS 上 /tmp 是 /private/tmp 的软链）。
 */
let extId = '';
async function useBrowserEngine(targets, testDist) {
  const hex = createHash('sha256').update(fs.realpathSync(testDist)).digest('hex').slice(0, 32);
  for (const c of hex) extId += String.fromCharCode(97 + parseInt(c, 16));

  let swTarget = targets.find(
    (t) => t.type === 'service_worker' && t.url.startsWith(`chrome-extension://${extId}/`),
  );
  for (let i = 0; i < 20 && !swTarget; i += 1) {
    await sleep(300);
    const list = await (await fetch(`http://127.0.0.1:${port + 500}/json/list`)).json();
    swTarget = list.find(
      (t) => t.type === 'service_worker' && t.url.startsWith(`chrome-extension://${extId}/`),
    );
  }
  if (!swTarget) throw new Error('找不到 Service Worker target');

  const sw = await connect(swTarget.webSocketDebuggerUrl);
  await sw.send('Runtime.enable');
  sw.on((msg) => {
    if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
      console.log('   [SW]', (msg.params.args || []).map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 400));
    }
    if (msg.method === 'Runtime.exceptionThrown') {
      console.log('   [SW 异常]', (msg.params.exceptionDetails?.exception?.description || '').slice(0, 400));
    }
  });
  await sw.eval(
    `chrome.storage.local.set({'rednote.settings': {downloadMode: 'browser'}}).then(() => 'ok')`,
  );
  console.log('▶ 已切到「浏览器下载」模式');
  return sw;
}

function downloadRoot() {
  // 测试专用目录，不写用户的 ~/Downloads ——
  // 一是别去动用户自己的文件夹，二是 macOS 会拦着终端进程读 ~/Downloads
  // （「Operation not permitted」），那样测试根本数不到落盘的文件。
  return path.join(profileDir, 'downloads', '小红书下载');
}

/**
 * 把 Chrome 的下载目录指到测试目录。
 *
 * 没有这一步，文件会落到用户自己的 ~/Downloads 里 ——
 * 测试既污染用户环境，又因为系统权限读不到文件
 * （macOS 会拦着终端进程读 ~/Downloads，报「Operation not permitted」）。
 *
 * 用的是**用户配置**（Preferences）而不是 CDP 的 setDownloadBehavior：
 * 后者会让 Chrome 忽略每个下载项自己的相对路径，
 * 文件全平铺在目录里 —— 那就测不到「按笔记/按作者/全部平铺」了。
 */
function prepareDownloadDir() {
  const dir = path.join(profileDir, 'downloads');
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(path.join(profileDir, 'Default'), { recursive: true });
  const prefsPath = path.join(profileDir, 'Default', 'Preferences');
  const prefs = fs.existsSync(prefsPath)
    ? JSON.parse(fs.readFileSync(prefsPath, 'utf8') || '{}')
    : {};
  prefs.download = {
    ...(prefs.download || {}),
    default_directory: dir,
    prompt_for_download: false,
    directory_upgrade: true,
  };
  prefs.savefile = { ...(prefs.savefile || {}), default_directory: dir };
  fs.writeFileSync(prefsPath, JSON.stringify(prefs));
  return dir;
}

async function main() {
  // 「服务端渲染的 HTML 里有没有笔记详情」—— 真站点未登录时是没有的，
  // 详情是页面 JS 用 XHR 拉的。两种都要测。
  let ssrDetail = true;
  // 「SSR 里的直链跟页面渲染出来的不一样」—— 用来验证扩展是不是下到了页面看到的那一份。
  let ssrMediaDiffers = false;
  // 「详情在状态里的位置」—— 站点改版时这个位置会变。
  let detailPath = 'noteDetailMap';
  // 「详情是不是只从接口来」—— 页面自己 XHR 拿，状态里没有。
  let viaApi = false;
  // 「详情只从接口来，而且是用 XHR + responseType:'json' 拿的」——
  // 真站点用 axios，走的就是这条路。
  let viaApiXhr = false;
  // 每轮开始的时间：用来算「这一轮新落盘的文件」
  let roundStart = Date.now();
  const { counter, record } = makeRequestCounter();

  const server = createServer((req, res) => {
    record(req);
    const url = new URL(req.url, 'http://127.0.0.1');
    res.setHeader('content-type', 'text/html; charset=utf-8');
    if (url.pathname.startsWith('/media/')) {
      // 坏直链：故意 404 —— 下它就等于下不到东西
      res.statusCode = 404;
      res.end('not found');
      return;
    }
    if (url.pathname.startsWith('/user/profile/')) {
      res.end(profileHtml());
      return;
    }
    // 笔记详情接口（页面自己 XHR 拿的那份）
    if (url.pathname === '/api/sns/web/v1/feed') {
      const id = url.searchParams.get('note_id') ?? '';
      const note = NOTES.find((n) => n.id === id);
      res.setHeader('content-type', 'application/json; charset=utf-8');
      res.end(
        JSON.stringify(
          note ? feedApiJson(note, noteDetail(note)) : { success: false, data: { items: [] } },
        ),
      );
      return;
    }
    const explore = url.pathname.match(/^\/explore\/([A-Za-z0-9_-]+)/);
    if (explore) {
      const note = NOTES.find((n) => n.id === explore[1]);
      if (note) {
        // 抓 HTML（Sec-Fetch-Dest: empty）和页面导航（iframe）给不同的内容：
        // 导航给「页面渲染的那份」，抓取给「SSR 那份」。
        const isFetch = String(req.headers['sec-fetch-dest'] || '') === 'empty';
        res.end(
          noteHtml(
            note,
            ssrDetail,
            isFetch && ssrMediaDiffers ? breakVideoUrl : null,
            detailPath,
            viaApi,
            viaApiXhr,
          ),
        );
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
  BROKEN_VIDEO_URL = `${origin}/media/broken-video.mp4`;
  for (const cs of manifest.content_scripts) cs.matches.push(`${origin}/*`);
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

  prepareDownloadDir();

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
    await sleep(5000);
    const targets = await (await fetch(`http://127.0.0.1:${port + 500}/json/list`)).json();
    const page = targets.find((t) => t.type === 'page');
    if (!page) throw new Error('找不到页面 target');

    // 这个脚本测的是「交给浏览器下载」那条路径（自研引擎由 e2e-self.mjs 覆盖）。
    // 默认是自研引擎，所以这里显式把下载方式改成 browser。
    await useBrowserEngine(targets, testDist);

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

    /**
     * 问页面里那个钩子一个问题（跟扩展问它的是同一条通道）。
     *
     * 出问题时要知道「这一轮到底走的哪条路」——
     * 解析失败可以有好几种原因（状态里没有、接口没抓到、钩子没起来），
     * 不问清楚就只能靠猜。
     */
    const askPage = async (method, params = {}, timeoutMs = 3000) => {
      const raw = await evaluate(`
        new Promise((resolve) => {
          const ch = document.documentElement.getAttribute('data-rednote-channel');
          if (!ch) { resolve(JSON.stringify({ ok: false, error: '页面里没有钩子' })); return; }
          const id = 'e2e-' + Math.random().toString(36).slice(2);
          const done = (v) => {
            clearTimeout(timer);
            window.removeEventListener('message', onMsg);
            resolve(JSON.stringify(v));
          };
          const onMsg = (e) => {
            const d = e.data;
            if (!d || d.__rednote !== ch || d.id !== id) return;
            if (typeof d.method === 'string') return;  // 自己发出去的请求回声
            done(d);
          };
          const timer = setTimeout(() => done({ ok: false, error: '超时' }), ${timeoutMs});
          window.addEventListener('message', onMsg);
          window.postMessage({ __rednote: ch, id, method: ${JSON.stringify(method)}, params: ${JSON.stringify(params)} }, '*');
        })
      `);
      try {
        return JSON.parse(raw);
      } catch {
        return { ok: false, error: String(raw) };
      }
    };

    /**
     * 打开面板，等到它真的闲下来（按钮变回「开始下载」而且没禁用）。
     *
     * 卡片是边扫边挂的：解析还没完的时候，「开始下载」按钮写着「解析中…」
     * 而且是禁用的。这时候点下去等于点了个禁用按钮，什么都不会发生 ——
     * 测出来是「一条都没下」，看着像扩展坏了，其实是测试自己没点到。
     */
    const openPanelAndWait = async () => {
      for (let i = 0; i < 40; i += 1) {
        const ok = await evaluate(
          `!!document.querySelector('rednote-root')?.shadowRoot?.querySelector('.rn-fab')`,
        );
        if (ok) break;
        await sleep(400);
      }
      await evaluate(`
        (() => {
          const sr = document.querySelector('rednote-root').shadowRoot;
          sr.querySelector('.rn-fab').click();
          return true;
        })()
      `);
      for (let i = 0; i < 80; i += 1) {
        await sleep(400);
        const raw = await evaluate(`
          (() => {
            const sr = document.querySelector('rednote-root')?.shadowRoot;
            const btn = sr?.querySelector('.rn-footer .rn-btn[data-variant="primary"]');
            return JSON.stringify({
              cards: sr?.querySelectorAll('.rn-card').length ?? 0,
              ready: /开始下载/.test(btn?.textContent || '') && btn?.disabled !== true,
            });
          })()
        `);
        const st = (() => {
          try {
            return JSON.parse(raw) || {};
          } catch {
            return {};
          }
        })();
        if (st.cards >= 3 && st.ready) return st;
      }
      return null;
    };

    /**
     * 跑一轮「主页批量下载」：重新加载页面 → 打开面板 → 全选 → 开始下载，
     * 返回这一轮新落盘的文件。
     *
     * 每轮都要重新加载页面：那样才是新的 content script 实例，
     * 解析路径的判断从头开始（这几轮测的就是「站点换形状时扩展还灵不灵」）。
     */
    const runRound = async () => {
      await cdp.send('Page.navigate', {
        url: `${origin}/user/profile/mockuser0001?xsec_token=mock`,
      });
      await sleep(2000);
      // 等扫描出卡片，**并且等面板真的闲下来** ——
      // 卡片是边扫边挂的：解析还没完的时候，「开始下载」按钮写着「解析中…」
      // 而且是禁用的。这时候点下去等于点了个禁用按钮，什么都不会发生 ——
      // 测出来就是「一条都没下」，看着像扩展坏了，其实是测试自己没点到。
      await openPanelAndWait();

      const roundStart = Date.now();
      await evaluate(`
        (() => {
          const sr = document.querySelector('rednote-root').shadowRoot;
          const all = [...sr.querySelectorAll('.rn-toolbar-right .rn-btn')].find(b => /全选/.test(b.textContent));
          if (all) all.click();
          const start = sr.querySelector('.rn-footer .rn-btn[data-variant="primary"]');
          if (start) start.click();
          return true;
        })()
      `);

      // 等这一批解析完：解析中时按钮写着「解析中…」，做完才变回「开始下载」
      const startedAt = Date.now();
      for (let t = 0; t < 120; t += 1) {
        await sleep(500);
        const st = await evaluate(`
          (() => {
            const sr = document.querySelector('rednote-root')?.shadowRoot;
            return (sr?.querySelector('.rn-footer')?.textContent || '').slice(0, 60);
          })()
        `);
        if (typeof st === 'string' && /开始下载/.test(st) && !/正在解析/.test(st)) break;
      }
      console.log(`   解析用时: ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
      // 这一轮到底走的哪条路（抓 HTML / 隐藏 iframe / 接口响应）
      console.log('   解析路径:', JSON.stringify(await askPage('api.parsePath')));
      console.log(`   站点请求: iframe ${counter.iframe} 个 / 抓取 ${counter.fetch} 次`);
      let fresh = [];
      for (let i = 0; i < 60; i += 1) {
        await sleep(700);
        fresh = freshSince(downloadRoot(), roundStart);
        if (fresh.length >= 4) break;
      }

      const footer = await evaluate(`
        (() => {
          const sr = document.querySelector('rednote-root').shadowRoot;
          return JSON.stringify({
            footer: sr.querySelector('.rn-footer')?.textContent?.slice(0, 200) || '',
          });
        })()
      `);
      console.log('   本轮目录:', walk(downloadRoot()).map((f) => path.relative(downloadRoot(), f)).join(' | '));
      console.log('   本轮面板:', footer);

      // 这一轮每张卡片的状态 —— 出问题时一眼能看出是「没解析出来」还是「解析了但没资源」
      const states = await evaluate(`
        (() => {
          const sr = document.querySelector('rednote-root').shadowRoot;
          return JSON.stringify([...sr.querySelectorAll('.rn-card')].map(c => ({
            title: c.querySelector('.rn-card-title')?.textContent || '',
            meta: c.querySelector('.rn-card-meta')?.textContent || '',
          })));
        })()
      `);
      // 面板上写着的解析路径 —— 用户能看见「这批是怎么解析出来的」
      const headSub = await evaluate(`
        (() => {
          const sr = document.querySelector('rednote-root')?.shadowRoot;
          return sr?.querySelector('.rn-panel .rn-head-sub')?.textContent || '';
        })()
      `);
      return { fresh, states: JSON.parse(states || '[]'), headSub: String(headSub || '') };
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

    check('主页扫描出卡片', (vm?.cards || []).length === 4, `cards=${JSON.stringify(vm?.cards)}`);
    check(
      '分类计数正确（视频 2 / 图集 2）',
      /视频\s*2/.test(vm?.headSub || '') && /图集\s*2/.test(vm?.headSub || ''),
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
    check('全选生效', afterSelect.selected === 4, `selected=${afterSelect.selected} footer=${afterSelect.footer}`);
    check(
      '主按钮带数量',
      /4/.test(afterSelect.startBtn || ''),
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

    roundStart = Date.now();
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
    let settled = false;
    for (let i = 0; i < 60; i += 1) {
      await sleep(700);
      const fresh = freshSince(downloadRoot(), roundStart);
      if (fresh.length >= 4) {
        settled = true;
        break;
      }
    }
    const fresh = freshSince(downloadRoot(), roundStart);


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

    // 解析走的是哪条路 —— 这一条直接决定几百条笔记时机器会不会卡，
    // 也决定下到的是不是「用户眼睛看到的那份」。
    // 隐藏 iframe：读页面渲染后的状态（1.0.0 就是这么干的，最权威）
    // 抓 HTML：读服务端渲染出来的那份 —— 只有跟页面那份逐条比对过完全一致才准接手
    check(
      '主路是隐藏 iframe（跟 1.0.0 一样）：4 条笔记各开一个页面',
      counter.iframe === 4,
      `iframe ${counter.iframe} 个 / 抓取 ${counter.fetch} 次`,
    );
    check(
      '快路只自证一次，不是给每条笔记都白打一遍',
      counter.fetch <= 2,
      `抓取 ${counter.fetch} 次（4 条笔记：1 次自证 + 空壳那条的兜底）—— ` +
        '每条都白打一遍会把站点压力翻倍，还会跟 iframe 抢连接池，把解析成功率拖下去',
    );

    // 媒体拿不到的那条笔记必须**看得见地失败**，不能是「解析成功但一个视频都没有」
    const shellCard = await evaluate(`
      (() => {
        const sr = document.querySelector('rednote-root').shadowRoot;
        const cards = [...sr.querySelectorAll('.rn-card')];
        const card = cards.find(c => (c.textContent || '').includes('媒体还没补上的笔记'));
        return JSON.stringify({
          found: !!card,
          meta: card?.querySelector('.rn-card-meta')?.textContent || '',
          text: (card?.textContent || '').slice(0, 120),
        });
      })()
    `);
    const shell = JSON.parse(shellCard);
    check(
      '没拿到资源的笔记标成「未取到资源」（不静默成功，也不谎报解析失败）',
      shell.found && /未取到资源/.test(shell.meta),
      `卡片状态：${shell.meta || shell.text}`,
    );

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
      filterState.cards === 4,
      `cards=${filterState.cards}`,
    );
    check(
      '底部说明当前只下载视频',
      (filterState.selected || []).join(',') === '视频' && /只下载视频/.test(filterState.footerSub),
      `selected=${JSON.stringify(filterState.selected)} footerSub=${filterState.footerSub}`,
    );

    roundStart = Date.now();
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
        .filter((f) => freshSince(downloadRoot(), roundStart).includes(f))
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

    roundStart = Date.now();
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
        .filter((f) => freshSince(downloadRoot(), roundStart).includes(f))
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

    roundStart = Date.now();
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
        .filter((f) => freshSince(downloadRoot(), roundStart).includes(f))
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

    /* ------------------------------------------------------------------ */
    /* 第四轮：SSR 的 HTML 里没有笔记详情（真站点未登录时就是这样）         */
    /* ------------------------------------------------------------------ */

    console.log('\n▶ 换成「SSR 里没有详情」的站点，再下载一次…');
    ssrDetail = false;
    counter.fetch = 0;
    counter.iframe = 0;
    counter.other = 0;

    // 重新加载页面 = 新的 content script 实例（路径判定从头开始）
    await cdp.send('Page.navigate', {
      url: `${origin}/user/profile/mockuser0001?xsec_token=mock`,
    });
    await sleep(2000);
    await openPanelAndWait();


    roundStart = Date.now();
    await evaluate(`
      (() => {
        const sr = document.querySelector('rednote-root').shadowRoot;
        const all = [...sr.querySelectorAll('.rn-toolbar-right .rn-btn')].find(b => /全选/.test(b.textContent));
        if (all) all.click();
        const start = sr.querySelector('.rn-footer .rn-btn[data-variant="primary"]');
        if (start) start.click();
        return true;
      })()
    `);

    let noSsrFresh = [];
    for (let i = 0; i < 60; i += 1) {
      await sleep(700);
      noSsrFresh = freshSince(downloadRoot(), roundStart);
      if (noSsrFresh.length >= 4) break;
    }
    check(
      '没有 SSR 详情时照样能下全（退回 iframe 兜底）',
      noSsrFresh.length === 4,
      `新增 ${noSsrFresh.length} 个`,
    );
    check(
      '兜底时用的是隐藏 iframe（每条笔记一个页面导航）',
      counter.iframe === 4,
      `iframe ${counter.iframe} 个 / 抓取 ${counter.fetch} 次`,
    );
    check(
      '快路不可用时只多花一两次抓取，不是每条笔记都白打一遍',
      counter.fetch <= 2,
      `抓取 ${counter.fetch} 次（笔记 4 条）—— 每条都白抓一次的话会把站点压力翻倍，` +
        '还会跟 iframe 抢连接池，把解析成功率拖下去',
    );

    for (const f of noSsrFresh) {
      try {
        fs.rmSync(f, { force: true });
      } catch {
        /* ignore */
      }
    }

    /* ------------------------------------------------------------------ */
    /* 第五轮：SSR 里的直链跟页面看到的不一样                               */
    /* ------------------------------------------------------------------ */

    console.log('\n▶ 换成「SSR 直链是坏的」的站点，再下载一次…');
    ssrDetail = true;
    ssrMediaDiffers = true;
    counter.fetch = 0;
    counter.iframe = 0;
    counter.other = 0;

    // 重新加载页面 = 新的 content script 实例（路径判定从头开始）
    await cdp.send('Page.navigate', {
      url: `${origin}/user/profile/mockuser0001?xsec_token=mock`,
    });
    await sleep(2000);
    await openPanelAndWait();


    roundStart = Date.now();
    await evaluate(`
      (() => {
        const sr = document.querySelector('rednote-root').shadowRoot;
        const all = [...sr.querySelectorAll('.rn-toolbar-right .rn-btn')].find(b => /全选/.test(b.textContent));
        if (all) all.click();
        const start = sr.querySelector('.rn-footer .rn-btn[data-variant="primary"]');
        if (start) start.click();
        return true;
      })()
    `);

    let diffFresh = [];
    for (let i = 0; i < 60; i += 1) {
      await sleep(700);
      diffFresh = freshSince(downloadRoot(), roundStart);
      if (diffFresh.length >= 4) break;
    }

    // 关键：视频必须下到**页面渲染的那份**（好的那条直链），
    // 而不是 SSR 里那条（坏的，404）。
    const diffVideo = diffFresh.find((f) => f.endsWith('.mp4'));
    check(
      'SSR 直链跟页面不一样时，下的是页面那份（不是 SSR 那份坏地址）',
      Boolean(diffVideo) && fs.statSync(diffVideo).size > 1024,
      diffVideo ? `${path.basename(diffVideo)}=${fs.statSync(diffVideo).size}B` : '没下到视频',
    );
    check(
      '图片也照样下到了',
      diffFresh.filter((f) => /\.(jpg|jpeg|png|webp)$/i.test(f)).length === 3,
      diffFresh.map((f) => path.basename(f)).join(', '),
    );
    check(
      '发现直链对不上就整场退回页面渲染（不再用 SSR 那份）',
      counter.iframe === 4,
      `iframe ${counter.iframe} 个 / 抓取 ${counter.fetch} 次`,
    );

    for (const f of diffFresh) {
      try {
        fs.rmSync(f, { force: true });
      } catch {
        /* ignore */
      }
    }

    /* ------------------------------------------------------------------ */
    /* 第六轮：详情被挪到了状态里的另一个位置                                */
    /* ------------------------------------------------------------------ */

    console.log('\n▶ 换成「详情挪了位置」的站点，再下载一次…');
    detailPath = 'currentNote';
    ssrDetail = true;
    ssrMediaDiffers = false;
    counter.fetch = 0;
    counter.iframe = 0;
    counter.other = 0;

    const moved = await runRound();
    check(
      '详情换了位置也照样解析得出来（深搜兜底）',
      moved.fresh.length === 4,
      `新增 ${moved.fresh.length} 个 · 卡片：${JSON.stringify(moved.states)}`,
    );
    check(
      '换了位置时下载的还是视频，不是别的',
      moved.fresh.some((f) => f.endsWith('.mp4')) &&
        moved.fresh.filter((f) => /\.(jpg|jpeg|png|webp)$/i.test(f)).length === 3,
      moved.fresh.map((f) => path.basename(f)).join(', '),
    );

    for (const f of moved.fresh) {
      try {
        fs.rmSync(f, { force: true });
      } catch {
        /* ignore */
      }
    }

    /* ------------------------------------------------------------------ */
    /* 第七轮：详情只从接口来（状态里压根没有）                             */
    /* ------------------------------------------------------------------ */

    console.log('\n▶ 换成「详情只从接口来」的站点，再下载一次…');
    viaApi = true;
    detailPath = 'noteDetailMap';
    counter.fetch = 0;
    counter.iframe = 0;
    counter.other = 0;

    const viaApiFiles = await runRound();
    check(
      '详情只从接口来时也解析得出来（从抓到的接口响应里找）',
      viaApiFiles.fresh.length === 4,
      `新增 ${viaApiFiles.fresh.length} 个 · 卡片：${JSON.stringify(viaApiFiles.states)}`,
    );
    check(
      '接口来的详情下的是视频',
      viaApiFiles.fresh.some((f) => f.endsWith('.mp4')),
      viaApiFiles.fresh.map((f) => path.basename(f)).join(', '),
    );
    check(
      '面板上写明这批走的是「接口响应」',
      /接口响应/.test(viaApiFiles.headSub),
      viaApiFiles.headSub,
    );

    for (const f of viaApiFiles.fresh) {
      try {
        fs.rmSync(f, { force: true });
      } catch {
        /* ignore */
      }
    }

    /* ------------------------------------------------------------------ */
    /* 第八轮：详情只从接口来，而且是用 XHR + responseType:'json' 拿的     */
    /* ------------------------------------------------------------------ */

    console.log("\n▶ 换成「详情用 axios 那种 XHR 拿」的站点，再下载一次…");
    viaApi = false;
    viaApiXhr = true;
    counter.fetch = 0;
    counter.iframe = 0;
    counter.other = 0;

    const viaXhrFiles = await runRound();
    check(
      'XHR + responseType:json 的接口响应也抓得到（真站点用 axios）',
      viaXhrFiles.fresh.length === 4,
      `新增 ${viaXhrFiles.fresh.length} 个 · 卡片：${JSON.stringify(viaXhrFiles.states)}`,
    );
    check(
      'XHR 来的详情下的是视频',
      viaXhrFiles.fresh.some((f) => f.endsWith('.mp4')),
      viaXhrFiles.fresh.map((f) => path.basename(f)).join(', '),
    );
    check(
      'XHR 来的详情走的是「接口响应」那条路（不是 SSR —— SSR 里压根没有详情）',
      /接口响应/.test(viaXhrFiles.headSub),
      viaXhrFiles.headSub,
    );

    for (const f of viaXhrFiles.fresh) {
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
