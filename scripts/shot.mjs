/**
 * 面板截图：改完 UI 之后肉眼确认一下版面。
 *
 * 用法：node scripts/shot.mjs [输出路径]
 * 前置：npm run build
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
const out = process.argv[2] || path.join(root, '.tmp', 'panel.png');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const CHROME = path.join(
  process.env.HOME ?? '',
  'Library/Caches/ms-playwright/chromium-1248/chrome-mac-arm64',
  'Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
);
const COVER =
  'https://sns-webpic-qc.xhscdn.com/202610241249/036c3b98f180befdb20ada1f779c0111/' +
  '1040g2sg325d5f1ni4q005n341tr4na22ndh5mg8!nd_dft_wlteh_webp_3';

const NOTE = {
  noteId: 'shotnote0001',
  type: 'video',
  title: '傍晚的海边，日落把云染成了橘子汽水',
  desc: '随手拍的一组照片',
  user: { nickname: '林间有风', userId: 'shotuser001' },
  imageList: [],
  video: {
    media: {
      stream: {
        h264: [
          {
            masterUrl:
              'https://sns-bak-v1.xhscdn.com/stream/79/110/258/01eab1a3bcc06cc24f037001a0c5e9440a_258.mp4',
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

function noteHtml() {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<script>window.__INITIAL_STATE__ = ${JSON.stringify({
    note: { firstNoteId: NOTE.noteId, noteDetailMap: { [NOTE.noteId]: { note: NOTE } } },
  })};</script></head><body><div id="app"></div></body></html>`;
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

const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rn-shot-'));
const testDist = path.join(profileDir, 'dist');
const port = 9950 + (process.pid % 40);
let chrome;

async function main() {
  const server = createServer((req, res) => {
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end(noteHtml());
  });
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${port}`;

  fs.cpSync(dist, testDist, { recursive: true });
  const manifestPath = path.join(testDist, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  for (const cs of manifest.content_scripts) cs.matches.push(`${origin}/*`);
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

  const hex = createHash('sha256').update(fs.realpathSync(testDist)).digest('hex').slice(0, 32);
  let extId = '';
  for (const c of hex) extId += String.fromCharCode(97 + parseInt(c, 16));

  chrome = spawn(
    CHROME,
    [
      `--user-data-dir=${profileDir}`,
      `--remote-debugging-port=${port + 300}`,
      `--disable-extensions-except=${testDist}`,
      `--load-extension=${testDist}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--window-size=1280,900',
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
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 1280,
    height: 900,
    deviceScaleFactor: 2,
    mobile: false,
  });
  await cdp.send('Page.navigate', { url: `${origin}/explore/${NOTE.noteId}?xsec_token=mock` });

  for (let i = 0; i < 40; i += 1) {
    const ok = await cdp.eval(
      `!!document.querySelector('rednote-root')?.shadowRoot?.querySelector('.rn-panel')`,
    );
    if (ok) break;
    await sleep(300);
  }
  // 打开面板
  await cdp.eval(
    `document.querySelector('rednote-root').shadowRoot.querySelector('.rn-fab').click(); true`,
  );
  await sleep(1200);

  const box = await cdp.eval(`
    (() => {
      const p = document.querySelector('rednote-root').shadowRoot.querySelector('.rn-panel');
      const r = p.getBoundingClientRect();
      return JSON.stringify({ x: r.x, y: r.y, width: r.width, height: r.height });
    })()
  `);
  const rect = JSON.parse(box);
  const shot = await cdp.send('Page.captureScreenshot', {
    format: 'png',
    captureBeyondViewport: true,
    clip: {
      x: Math.max(0, rect.x - 8),
      y: Math.max(0, rect.y - 8),
      width: rect.width + 16,
      height: rect.height + 16,
      scale: 2,
    },
  });
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, Buffer.from(shot.data, 'base64'));
  console.log(`✓ 截图已保存：${out}`);

  // 顺带量一下版面：操作区按钮有没有被挤到别的地方
  const layout = await cdp.eval(`
    (() => {
      const sr = document.querySelector('rednote-root').shadowRoot;
      const row = sr.querySelector('.rn-row');
      if (!row) return 'no row';
      const name = row.querySelector('.rn-row-name').getBoundingClientRect();
      const action = row.querySelector('.rn-row-action')?.getBoundingClientRect();
      const btn = row.querySelector('.rn-row-action button')?.getBoundingClientRect();
      return JSON.stringify({
        rowWidth: row.getBoundingClientRect().width,
        nameRight: name.right,
        actionLeft: action?.left,
        btnLeft: btn?.left,
        btnRight: btn?.right,
      });
    })()
  `);
  console.log('版面：', layout);

  cleanup();
}

main().catch((err) => {
  console.error('截图失败:', err);
  try {
    chrome?.kill();
  } catch {
    /* ignore */
  }
  process.exitCode = 1;
});
