/**
 * 实测 declarativeNetRequest 的 MODIFY_HEADERS 规则，
 * 对「Service Worker 里 chrome.downloads.download() 发起的请求」到底有没有效。
 *
 * 为什么要验：DNR 规则是给 xhscdn 请求补 Referer 的防御性措施，
 * 但如果它对 SW 发起的下载根本不生效，那这条规则加上
 * declarativeNetRequestWithHostAccess 权限就是纯负担 ——
 * 商店会为它多显示一条权限说明，用户要为此买单。
 *
 * 做法：本地起一个回显请求头的 HTTP 服务器，
 * 装一条针对它的 DNR 规则，然后从 SW 里下载这个地址，看服务器收到什么。
 *
 * 运行：node scripts/probe-dnr.mjs
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
const profile = `/tmp/rednote-dnr-probe-${process.pid}`;
const debugPort = 9600 + (process.pid % 150);
const httpPort = 9800 + (process.pid % 150);

/**
 * 测试专用的扩展副本：把 127.0.0.1 加进 host_permissions。
 *
 * 不加的话 DNR 根本不会碰本地地址的请求 ——
 * declarativeNetRequestWithHostAccess 只对扩展有 host 权限的主机生效，
 * 那样测出来的「规则无效」其实是权限范围不对，不是规则本身的问题。
 */
const testDist = `/tmp/rednote-dnr-probe-dist-${process.pid}`;
cpSync(dist, testDist, { recursive: true });
const manifestPath = path.join(testDist, 'manifest.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
manifest.host_permissions = [...(manifest.host_permissions ?? []), `http://127.0.0.1:${httpPort}/*`];
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

const CHROME_CANDIDATES = [
  path.join(
    process.env.HOME ?? '',
    'Library/Caches/ms-playwright/chromium-1248/chrome-mac-arm64',
    'Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
  ),
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
];

function resolveChrome() {
  for (const c of CHROME_CANDIDATES) if (existsSync(c)) return c;
  throw new Error('找不到可用的 Chrome');
}

/** 服务器收到过的请求头 */
const seen = [];

/** 回显服务器：把请求头写进 seen，并返回一段固定内容 */
const server = createServer((req, res) => {
  seen.push({ url: req.url, headers: { ...req.headers } });
  res.writeHead(200, { 'content-type': 'text/plain' });
  res.end('x'.repeat(64));
});

let chromeProc = null;
process.on('exit', () => {
  try {
    chromeProc?.kill();
  } catch {
    /* ignore */
  }
  server.close();
});

async function evalIn(target, expression) {
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r, { once: true }));
  const id = { v: 0 };
  const pend = new Map();
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pend.has(m.id)) {
      pend.get(m.id)(m);
      pend.delete(m.id);
    }
  });
  const send = (method, params = {}) => {
    const n = ++id.v;
    ws.send(JSON.stringify({ id: n, method, params }));
    return new Promise((r) => pend.set(n, r));
  };
  await send('Runtime.enable');
  const res = await send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  ws.close();
  if (res.result?.exceptionDetails) throw new Error(res.result.exceptionDetails.text || '执行异常');
  return res.result?.result?.value;
}

let swTarget = null;
async function findOurSW() {
  if (swTarget) return swTarget;
  const list = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
  const workers = list.filter(
    (t) => t.type === 'service_worker' && String(t.url || '').startsWith('chrome-extension://'),
  );
  for (const t of workers) {
    try {
      const name = await evalIn(t, `try{chrome.runtime.getManifest().name}catch(e){'?'}`);
      if (name === '小红书下载器') {
        swTarget = t;
        return t;
      }
    } catch {
      /* 试下一个 */
    }
  }
  throw new Error('找不到本扩展的 service worker');
}

async function main() {
  await new Promise((r) => server.listen(httpPort, '127.0.0.1', r));
  rmSync(profile, { recursive: true, force: true });
  mkdirSync(profile, { recursive: true });

  chromeProc = spawn(
    resolveChrome(),
    [
      `--user-data-dir=${profile}`,
      `--remote-debugging-port=${debugPort}`,
      `--disable-extensions-except=${testDist}`,
      `--load-extension=${testDist}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--headless=new',
    ],
    { stdio: 'ignore' },
  );

  let ready = false;
  for (let i = 0; i < 60; i += 1) {
    await new Promise((r) => setTimeout(r, 500));
    try {
      await findOurSW();
      ready = true;
      break;
    } catch {
      /* 还没起来 */
    }
  }
  if (!ready) throw new Error('Chrome 启动超时');

  const sw = await findOurSW();
  const target = `http://127.0.0.1:${httpPort}/probe.bin`;

  // 装一条针对本地地址的 DNR 规则：强制加一个 X-Probe 头
  const ruleId = 9001;
  const install = await evalIn(
    sw,
    `(async()=>{
      try {
        await chrome.declarativeNetRequest.updateSessionRules({
          removeRuleIds: [${ruleId}],
          addRules: [{
            id: ${ruleId},
            priority: 1,
            action: { type: 'modifyHeaders', requestHeaders: [
              { header: 'X-Probe', operation: 'set', value: 'from-dnr' },
              { header: 'Referer', operation: 'set', value: 'https://www.xiaohongshu.com/' },
            ]},
            condition: { urlFilter: '||127.0.0.1:${httpPort}', requestMethods: ['get','head'] },
          }],
        });
        return 'ok';
      } catch (e) { return 'ERR: ' + String(e && e.message || e); }
    })()`,
  );
  console.log('安装 DNR 规则:', install);

  // 规则到底有没有真的装上？（updateSessionRules 从 SW 里调可能直接静默失败）
  const installed = await evalIn(
    sw,
    `(async()=>{
      try {
        const rules = await chrome.declarativeNetRequest.getSessionRules();
        return JSON.stringify(rules.map(r=>({id:r.id, cond:r.condition, act:r.action.type})));
      } catch (e) { return 'ERR: ' + String(e && e.message || e); }
    })()`,
  );
  console.log('已安装的会话规则:', installed);

  // 对照实验：同一条规则对「页面里的 fetch」生效吗？
  // 如果 fetch 能拿到 X-Probe 而下载拿不到，就说明规则本身是对的，
  // 只是下载请求根本不走 DNR 这条路 —— 那这条规则对下载场景就是死代码。
  const pageTarget = `http://127.0.0.1:${httpPort}/page`;
  const page = await (await fetch(`http://127.0.0.1:${debugPort}/json/new?${encodeURIComponent(pageTarget)}`, { method: 'PUT' })).json();
  await new Promise((r) => setTimeout(r, 800));
  const fetchResult = await evalIn(
    page,
    `(async()=>{
      try {
        await fetch(${JSON.stringify(target)});
        return 'ok';
      } catch (e) { return 'ERR: ' + String(e && e.message || e); }
    })()`,
  );
  console.log('页面内 fetch:', fetchResult);
  await new Promise((r) => setTimeout(r, 800));

  // 从 SW 里下载这个地址
  const dl = await evalIn(
    sw,
    `(async()=>{
      try {
        const id = await chrome.downloads.download({
          url: ${JSON.stringify(target)},
          filename: 'dnr-probe.bin',
          conflictAction: 'uniquify',
          saveAs: false,
        });
        return 'download id=' + id;
      } catch (e) { return 'ERR: ' + String(e && e.message || e); }
    })()`,
  );
  console.log('下载:', dl);

  // 等服务器收到请求
  for (let i = 0; i < 40 && seen.length === 0; i += 1) {
    await new Promise((r) => setTimeout(r, 250));
  }

  console.log('\n===== 服务器收到的请求 =====');
  for (const s of seen) {
    const has = s.headers['x-probe'] === 'from-dnr';
    const ref = s.headers.referer ?? '无';
    console.log(
      `${s.url.padEnd(14)} mode=${(s.headers['sec-fetch-mode'] ?? '-').padEnd(8)} ` +
        `DNR头=${has ? '有' : '无'}  referer=${ref}`,
    );
  }

  if (seen.length === 0) {
    console.log('服务器没收到任何请求（下载可能没走到 HTTP）');
    return;
  }

  // 下载请求的特征：sec-fetch-mode=navigate 且没有 sec-fetch-dest=document
  const downloadReq = seen.find(
    (s) => s.url === '/probe.bin' && s.headers['sec-fetch-mode'] === 'navigate',
  );
  // 页面请求的特征：拿到了 DNR 加的 x-probe
  const pageReq = seen.find((s) => s.headers['x-probe'] === 'from-dnr');

  console.log('\n===== 结论 =====');
  console.log(`页面请求拿到 DNR 头: ${pageReq ? '✅ 规则本身有效' : '❌ 规则本身就没生效'}`);
  console.log(
    `SW 下载拿到 DNR 头: ${downloadReq?.headers['x-probe'] ? '✅ 有效' : '❌ 无效'}`,
  );
  if (pageReq && downloadReq && !downloadReq.headers['x-probe']) {
    console.log(
      '→ 规则对页面请求有效、对 SW 发起的下载无效：DNR 这条路根本管不到下载请求，\n' +
        '   所以给 xhscdn 装 Referer 规则是死代码，declarativeNetRequestWithHostAccess 权限可以删。',
    );
  }
}

main()
  .then(() => {
    chromeProc?.kill();
    process.exit(0);
  })
  .catch((e) => {
    console.error('探测失败:', e);
    chromeProc?.kill();
    process.exit(1);
  });
