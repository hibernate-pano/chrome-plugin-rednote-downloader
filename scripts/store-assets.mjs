#!/usr/bin/env node
/**
 * 生成 Chrome 商店上架要的素材。
 *
 * 产出三张图（商店的尺寸要求是硬性的，尺寸不对直接被拒）：
 *   out/store/screenshot-note.png    1280×800  笔记页 + 面板
 *   out/store/screenshot-batch.png   1280×800  主页批量 + 面板
 *   out/store/promo-440x280.png      440×280   小宣传图
 *
 * 用法：node scripts/store-assets.mjs [输出目录]
 * 前置：pnpm build
 *
 * 为什么用假页面：商店审核员看的是「装上之后长什么样」，
 * 而真站点需要登录、还会随时改版 —— 截图得能重复生成。
 * 假页面只用来**出图**，跟产品代码没有关系（fake-site.mjs 才是测产品用的）。
 *
 * ⚠️ 小宣传图不能带 alpha 通道（商店会拒）——
 * 这里用 Chrome 截 HTML 得到不透明的 PNG，
 * 不要改成 ImageMagick 栅格化 SVG（它的 SVG 渲染器不支持 linearGradient，会渲成黑底）。
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
const outDir = path.resolve(process.argv[2] || path.join(root, 'out', 'store'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 找一个能装扩展的 Chrome。
 * Chrome 137+ 的正式版禁用了 --load-extension ⇒ 必须用 Chrome for Testing / Chromium。
 * 写死版本号会在 playwright 升级缓存后失效，所以再扫一遍缓存目录取最新的。
 */
function resolveChrome() {
  const home = process.env.HOME ?? '';
  const cache = path.join(home, 'Library/Caches/ms-playwright');
  const candidates = [
    path.join(
      cache,
      'chromium-1248/chrome-mac-arm64',
      'Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
    ),
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ];
  if (fs.existsSync(cache)) {
    const dirs = fs
      .readdirSync(cache)
      .filter((d) => d.startsWith('chromium-'))
      .sort()
      .reverse();
    for (const d of dirs) {
      candidates.push(
        path.join(
          cache,
          d,
          'chrome-mac-arm64',
          'Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
        ),
      );
    }
  }
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  throw new Error('找不到可用的 Chrome（需要 Chrome for Testing 或 Chromium）');
}

const AUTHOR = '林间有风';
const NOTES = [
  { id: 'store0000001', token: 'tok-1', type: 'video', title: '傍晚的海边，日落把云染成了橘子汽水', likes: 1284 },
  { id: 'store0000002', token: 'tok-2', type: 'normal', title: '周末citywalk，随手拍的几张', likes: 962 },
  { id: 'store0000003', token: 'tok-3', type: 'video', title: '厨房实验：一次就成功的可颂', likes: 2311 },
  { id: 'store0000004', token: 'tok-4', type: 'normal', title: '雨天窗台的那杯茶', likes: 733 },
  { id: 'store0000005', token: 'tok-5', type: 'video', title: '夜骑十七公里，风都是甜的', likes: 3076 },
  { id: 'store0000006', token: 'tok-6', type: 'normal', title: '旧书店淘到的一本诗集', likes: 418 },
];

/** 封面用内联 SVG（渐变），不依赖外网 */
const cover = (from, to, label) =>
  'data:image/svg+xml;utf8,' +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="360" height="480" viewBox="0 0 360 480">
      <defs>
        <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stop-color="${from}"/><stop offset="1" stop-color="${to}"/>
        </linearGradient>
        <radialGradient id="s" cx="0.72" cy="0.28" r="0.5">
          <stop offset="0" stop-color="#ffffff" stop-opacity=".55"/>
          <stop offset="1" stop-color="#ffffff" stop-opacity="0"/>
        </radialGradient>
      </defs>
      <rect width="360" height="480" fill="url(#g)"/>
      <rect width="360" height="480" fill="url(#s)"/>
      <text x="24" y="452" font-size="17" fill="rgba(255,255,255,.72)"
            font-family="PingFang SC, sans-serif">${label}</text>
    </svg>`,
  );

const COVERS = [
  cover('#ff9a76', '#ff5f6d', '日落'),
  cover('#7fd8ff', '#3a7bd5', '街拍'),
  cover('#ffd76f', '#f79f1f', '可颂'),
  cover('#9be7c4', '#2f9e6f', '雨天'),
  cover('#b9a7ff', '#6c4bd8', '夜骑'),
  cover('#ffb3c6', '#d64d80', '书店'),
];

const SITE_CSS = `
  * { box-sizing: border-box; }
  body {
    margin: 0; background: #fff; color: #222;
    font: 14px/1.6 -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif;
  }
  .topbar {
    height: 56px; border-bottom: 1px solid #f0f0f0; display: flex;
    align-items: center; gap: 24px; padding: 0 24px; position: sticky; top: 0;
    background: #fff; z-index: 5;
  }
  .logo { color: #ff2e4d; font-size: 21px; font-weight: 700; letter-spacing: .5px; }
  .search {
    flex: 1; max-width: 420px; height: 36px; border-radius: 18px; background: #f5f5f5;
    color: #999; display: flex; align-items: center; padding: 0 16px; font-size: 13px;
  }
  .page { padding: 24px; margin-right: 480px; }
  .note-wrap { max-width: 420px; margin: 0 auto; }
  .note-title { font-size: 20px; font-weight: 600; margin: 8px 0 14px; }
  .author { display: flex; align-items: center; gap: 10px; margin-bottom: 18px; }
  .avatar {
    width: 36px; height: 36px; border-radius: 50%;
    background: linear-gradient(135deg, #ffb199, #ff5f6d);
  }
  .author-name { font-weight: 600; }
  .author-date { color: #999; font-size: 12px; }
  .cover {
    position: relative; border-radius: 12px; overflow: hidden;
    background: #f2f2f2; aspect-ratio: 3 / 4;
  }
  .cover img { width: 100%; height: 100%; object-fit: cover; display: block; }
  .play {
    position: absolute; inset: 0; margin: auto; width: 64px; height: 64px;
    border-radius: 50%; background: rgba(0,0,0,.42); display: flex;
    align-items: center; justify-content: center; color: #fff; font-size: 24px;
  }
  .stats { display: flex; gap: 22px; margin-top: 16px; color: #555; font-size: 13px; }
  .profile { max-width: 660px; margin: 0 auto; }
  .profile-head { display: flex; gap: 20px; align-items: center; padding: 12px 0 22px; }
  .profile-head .avatar { width: 84px; height: 84px; }
  .profile-name { font-size: 22px; font-weight: 700; }
  .profile-bio { color: #666; margin-top: 6px; }
  .profile-nums { display: flex; gap: 28px; margin-top: 10px; color: #555; font-size: 13px; }
  .grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 18px; }
  .card { }
  .card .cover { aspect-ratio: 3 / 4; border-radius: 10px; }
  .card .title { margin-top: 8px; font-size: 13px; color: #333; line-height: 1.45; }
  .card .likes { color: #999; font-size: 12px; margin-top: 4px; }
`;

/** 假站点的笔记页 */
function notePage(note) {
  const detail = {
    noteId: note.id,
    type: note.type,
    title: note.title,
    desc: '随手拍的一组照片',
    user: { nickname: AUTHOR, userId: 'storeuser01' },
    interactInfo: { likedCount: note.likes },
    imageList: [],
    video: {
      media: {
        stream: {
          h264: [
            {
              masterUrl: 'https://example.com/mock.mp4',
              backupUrls: [],
              duration: 4200,
              width: 720,
              height: 1280,
              size: 12 * 1024 * 1024,
              format: 'mp4',
            },
          ],
        },
      },
    },
  };
  const state = { note: { firstNoteId: note.id, noteDetailMap: { [note.id]: { note: detail } } } };
  const isVideo = note.type === 'video';
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<title>${note.title} - 小红书</title>
<script>window.__INITIAL_STATE__ = ${JSON.stringify(state)};</script>
<style>${SITE_CSS}</style>
</head><body>
  <div class="topbar"><span class="logo">小红书</span><div class="search">搜索小红书</div></div>
  <div class="page"><div class="note-wrap">
    <h1 class="note-title">${note.title}</h1>
    <div class="author">
      <div class="avatar"></div>
      <div><div class="author-name">${AUTHOR}</div>
      <div class="author-date">2026-10-20 上海</div></div>
    </div>
    <div class="cover">
      <img src="${COVERS[NOTES.indexOf(note)]}" alt="">
      ${isVideo ? '<div class="play">▶</div>' : ''}
    </div>
    <div class="stats"><span>♡ ${note.likes}</span><span>💬 86</span><span>☆ 收藏</span></div>
  </div></div>
</body></html>`;
}

/** 假站点的主页（批量扫描用的那一页） */
function profilePage() {
  const state = {
    user: {
      userPageData: { basicInfo: { nickname: AUTHOR } },
      notes: NOTES.map((n, i) => ({
        id: n.id,
        xsec_token: n.token,
        note_card: {
          display_title: n.title,
          type: n.type === 'video' ? 'video' : 'normal',
          cover: { url_default: COVERS[i] },
          interact_info: { liked_count: n.likes },
        },
      })),
    },
    note: { firstNoteId: NOTES[0].id, noteDetailMap: {} },
  };
  const cards = NOTES.map(
    (n, i) => `
      <div class="card">
        <div class="cover"><img src="${COVERS[i]}" alt=""></div>
        <div class="title">${n.title}</div>
        <div class="likes">♡ ${n.likes}</div>
      </div>`,
  ).join('');
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<title>${AUTHOR} - 小红书</title>
<script>window.__INITIAL_STATE__ = ${JSON.stringify(state)};</script>
<style>${SITE_CSS}</style>
</head><body>
  <div class="topbar"><span class="logo">小红书</span><div class="search">搜索小红书</div></div>
  <div class="page"><div class="profile">
    <div class="profile-head">
      <div class="avatar"></div>
      <div>
        <div class="profile-name">${AUTHOR}</div>
        <div class="profile-bio">拍照 / 做饭 / 骑车的普通周末</div>
        <div class="profile-nums"><span>关注 128</span><span>粉丝 2.4万</span><span>获赞与收藏 8.7万</span></div>
      </div>
    </div>
    <div class="grid">${cards}</div>
  </div></div>
</body></html>`;
}

/** 小宣传图：图标 + 名字 + 一句话。商店里它跟图标并排出现，得讲同一个故事。 */
function promoPage(iconDataUri) {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<style>
  * { box-sizing: border-box; }
  body {
    margin: 0; width: 440px; height: 280px; overflow: hidden;
    background: linear-gradient(135deg, #ff2e4d 0%, #ff6b3d 58%, #ffb03a 100%);
    font-family: -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif;
    color: #fff; display: flex; align-items: center; gap: 18px; padding: 26px;
  }
  img { width: 92px; height: 92px; border-radius: 22px; box-shadow: 0 8px 24px rgba(0,0,0,.22); }
  h1 { margin: 0 0 10px; font-size: 27px; letter-spacing: .5px; }
  p { margin: 0; font-size: 15px; line-height: 1.55; opacity: .96; }
  .tag { margin-top: 12px; display: inline-block; padding: 4px 11px; border-radius: 999px;
         background: rgba(255,255,255,.22); font-size: 12px; }
</style></head>
<body>
  <img src="${iconDataUri}" alt="">
  <div>
    <h1>小红书下载器</h1>
    <p>一键保存笔记里的视频和图片<br>主页还能批量扫描、勾选下载</p>
    <span class="tag">本地运行 · 不上传任何数据</span>
  </div>
</body></html>`;
}

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    ws.addEventListener('message', (e) => {
      const m = JSON.parse(e.data);
      if (m.id && this.pending.has(m.id)) {
        const { resolve, reject } = this.pending.get(m.id);
        this.pending.delete(m.id);
        if (m.error) reject(new Error(JSON.stringify(m.error)));
        else resolve(m.result);
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
      }, 30000);
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

async function main() {
  if (!fs.existsSync(path.join(dist, 'manifest.json'))) {
    throw new Error('dist/ 里没有构建产物，先跑 pnpm build');
  }

  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rn-store-'));
  const testDist = path.join(profileDir, 'dist');
  const port = 9700 + (process.pid % 60);
  let chrome;

  const server = createServer((req, res) => {
    res.setHeader('content-type', 'text/html; charset=utf-8');
    const url = new URL(req.url, 'http://127.0.0.1');
    const explore = url.pathname.match(/^\/explore\/([A-Za-z0-9_-]+)/);
    if (explore) {
      const note = NOTES.find((n) => n.id === explore[1]);
      if (note) {
        res.end(notePage(note));
        return;
      }
    }
    if (url.pathname.startsWith('/user/profile/')) {
      res.end(profilePage());
      return;
    }
    res.end('<!doctype html><html><body></body></html>');
  });
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${port}`;

  // 小宣传图走**另一个端口**（= 另一个源）：
  // 扩展的 content script 只匹配主端口这个源，挂在另一个源上就不会有任何扩展 UI 混进来。
  const promoServer = createServer((req, res) => {
    res.setHeader('content-type', 'text/html; charset=utf-8');
    const icon = fs
      .readFileSync(path.join(root, 'public', 'icons', 'icon-128.png'))
      .toString('base64');
    res.end(promoPage(`data:image/png;base64,${icon}`));
  });
  await new Promise((r) => promoServer.listen(port + 1, '127.0.0.1', r));
  const promoOrigin = `http://127.0.0.1:${port + 1}`;

  fs.cpSync(dist, testDist, { recursive: true });
  const manifestPath = path.join(testDist, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  for (const cs of manifest.content_scripts) cs.matches.push(`${origin}/*`);
  manifest.host_permissions = [...(manifest.host_permissions ?? []), `${origin}/*`];
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

  chrome = spawn(
    resolveChrome(),
    [
      `--user-data-dir=${profileDir}`,
      `--remote-debugging-port=${port + 300}`,
      `--disable-extensions-except=${testDist}`,
      `--load-extension=${testDist}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--window-size=1280,800',
      '--hide-scrollbars',
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
    promoServer.close();
    try {
      fs.rmSync(profileDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  };
  process.on('exit', cleanup);

  await sleep(4500);
  const list = await (await fetch(`http://127.0.0.1:${port + 300}/json/list`)).json();
  const pageTarget = list.find((t) => t.type === 'page');
  const ws = new WebSocket(pageTarget.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', rej, { once: true });
  });
  const cdp = new CDP(ws);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');

  fs.mkdirSync(outDir, { recursive: true });

  /** 截一张整屏图（尺寸必须精确到商店要的那一档） */
  const shoot = async (url, file, { width, height, openPanel = true, settle = 1600 }) => {
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await cdp.send('Page.navigate', { url });
    await sleep(1200);
    if (openPanel) {
      for (let i = 0; i < 40; i += 1) {
        const ok = await cdp.eval(
          `!!document.querySelector('rednote-root')?.shadowRoot?.querySelector('.rn-fab')`,
        );
        if (ok) break;
        await sleep(300);
      }
      await cdp.eval(
        `document.querySelector('rednote-root').shadowRoot.querySelector('.rn-fab').click(); true`,
      );
    }
    await sleep(settle);
    // 截图要的是**稳态**：
    //  - 首次运行的引导提示条 7 秒后自动消失，但它会挡住右上角 → 删掉
    //  - 主页扫描会把页面滚到底，标题就看不见了 → 滚回顶部
    await cdp.eval(`(() => {
      const sr = document.querySelector('rednote-root')?.shadowRoot;
      sr?.querySelectorAll('.rn-toast').forEach((n) => n.remove());
      window.scrollTo(0, 0);
      document.querySelectorAll('.reds-lock-scroll, #userPostedFeeds, .feeds-container, #noteContainer')
        .forEach((el) => { el.scrollTop = 0; });
      return true;
    })()`);
    await sleep(400);
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    const buf = Buffer.from(shot.data, 'base64');
    fs.writeFileSync(path.join(outDir, file), buf);
    console.log(`✓ ${file} — ${width}×${height} — ${(buf.length / 1024).toFixed(0)} KB`);
  };

  await shoot(`${origin}/explore/${NOTES[0].id}?xsec_token=tok-1`, 'screenshot-note.png', {
    width: 1280,
    height: 800,
  });
  await shoot(`${origin}/user/profile/storeuser01?xsec_token=mock`, 'screenshot-batch.png', {
    width: 1280,
    height: 800,
    settle: 3200,
  });
  await shoot(`${promoOrigin}/promo`, 'promo-440x280.png', {
    width: 440,
    height: 280,
    openPanel: false,
    settle: 600,
  });

  cleanup();
  console.log(`\n素材目录：${outDir}`);
}

main().catch((err) => {
  console.error('生成失败:', err);
  process.exit(1);
});
