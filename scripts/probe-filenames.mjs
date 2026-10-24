/**
 * 实测 Chromium 到底拒绝哪些文件名。
 *
 * 为什么要实测：`chrome.downloads.download()` 的 filename 参数只要含一个非法字符，
 * 整个调用就以 "Invalid filename" 直接失败 —— 不是「文件名被替换」，是整个下载没发生。
 * 而「非法」的判定规则散落在 net::IsSafePortableRelativePath 和 Shell 集成扩展名黑名单里，
 * 凭记忆写清洗规则迟早漏一条，漏一条就是一次静默失败。
 *
 * 做法：起一个带扩展的 Chrome，连到 Service Worker，逐个文件名试 chrome.downloads.download，
 * 把「抛错的名字」和「成功的名字」都打出来，成功���再删掉。
 *
 * 运行：node scripts/probe-filenames.mjs
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
const profile = `/tmp/rednote-filename-probe-${process.pid}`;
const port = 9800 + (process.pid % 150);

const CHROME_CANDIDATES = [
  path.join(
    process.env.HOME ?? '',
    'Library/Caches/ms-playwright/chromium-1248/chrome-mac-arm64',
    'Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
  ),
  path.join(
    process.env.HOME ?? '',
    'Library/Caches/ms-playwright/chromium-1194/chrome-mac',
    'Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
  ),
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
];

function resolveChrome() {
  for (const c of CHROME_CANDIDATES) if (existsSync(c)) return c;
  throw new Error('找不到可用的 Chrome');
}

/** 被测文件名：每一条对应一条我们怀疑会被拒的规则 */
const CASES = [
  { name: '普通中文', file: '正常文件名.jpg' },
  { name: '冒号', file: 'a:b.jpg' },
  { name: '星号', file: 'a*b.jpg' },
  { name: '问号', file: 'a?b.jpg' },
  { name: '双引号', file: 'a"b.jpg' },
  { name: '小于号', file: 'a<b.jpg' },
  { name: '大于号', file: 'a>b.jpg' },
  { name: '竖线', file: 'a|b.jpg' },
  { name: '反斜杠', file: 'a\\b.jpg' },
  { name: '正斜杠（当分隔符）', file: '子目录/文件.jpg' },
  { name: '前导点', file: '.隐藏文件.jpg' },
  { name: '结尾点', file: '文件.' },
  { name: '结尾空格', file: '文件 ' },
  { name: 'Windows 保留名 con', file: 'con.jpg' },
  { name: 'Windows 保留名 COM1', file: 'COM1.jpg' },
  { name: 'Shell 集成 .url', file: 'foo.url' },
  { name: 'Shell 集成 .lnk', file: 'foo.lnk' },
  { name: 'Shell 集成 .scf', file: 'foo.scf' },
  { name: 'Shell 集成 .local', file: 'foo.local' },
  { name: 'Shell 集成 .ade', file: 'foo.ade' },
  { name: 'Shell 集成 .adp', file: 'foo.adp' },
  { name: '零宽空格', file: 'a​b.jpg' },
  { name: '控制字符', file: 'a\u0007b.jpg' },
  { name: 'emoji', file: '视频🎬.mp4' },
  { name: '换行', file: 'a\nb.jpg' },
  // 目录段是否也守同样的规矩（我们的路径是 `作者/标题/01.jpg`）
  { name: '目录段含冒号', file: 'a:b/文件.jpg' },
  { name: '目录段前导点', file: '.hidden/文件.jpg' },
  { name: '目录段保留名', file: 'con/文件.jpg' },
  { name: '目录段结尾点', file: '目录./文件.jpg' },
  { name: '中间目录段前导点', file: '作者/.hidden/01.jpg' },
  { name: '只有点', file: '.' },
  { name: '两个点', file: '..' },
  { name: '空文件名', file: '' },
  { name: '纯空格', file: '   ' },
  { name: '扩展名前有点', file: '文件..jpg' },
  { name: '保留名带路径', file: 'a/con.jpg' },
  { name: '中文保留名', file: 'CON.txt' },
  // 精确化 Shell 扩展名规则：是看「整段」还是「最后那个扩展名」
  { name: 'url 但扩展名是 jpg', file: 'foo.url.jpg' },
  { name: 'url 作为目录名', file: 'foo.url/文件.jpg' },
  { name: '末尾是 .url', file: '文件.url' },
  { name: '中间是 .url', file: 'a.urlb.jpg' },
  // 保留名精确范围
  { name: 'COM0（不在保留名单）', file: 'COM0.jpg' },
  { name: 'LPT0（不在保留名单）', file: 'LPT0.jpg' },
  { name: 'con 单独一段', file: 'con' },
  { name: 'console（不是保留名）', file: 'console.jpg' },
  // 保留名看的是「第一个点之前」还是「最后一个点之前」
  { name: 'file.con.jpg', file: 'file.con.jpg' },
  { name: 'con.tar.gz', file: 'con.tar.gz' },
  { name: 'a.con', file: 'a.con' },
  // 空白位置
  { name: '前导空格', file: ' 文件.jpg' },
  { name: '中间空格', file: '文 件.jpg' },
  { name: '扩展名前空格', file: '文件 .jpg' },
  { name: 'tab', file: 'a\tb.jpg' },
  // 路径结构
  { name: '空目录段', file: 'a//b.jpg' },
  { name: '结尾斜杠', file: 'a/' },
  { name: '中文段 + 前导点目录', file: '昵称/.隐藏/01.jpg' },
  { name: '昵称目录', file: '昵称/标题/01.jpg' },
  // 前导点的各种形态
  { name: '两个点开头', file: '..foo.jpg' },
  { name: '前导点 + 多段扩展', file: '.foo.bar.jpg' },
  { name: '中间的点开头段', file: 'a/.b/c.jpg' },
  { name: '结尾两个点', file: 'a..b.' },
  // 空白出现在目录段
  { name: '目录段前导空格', file: 'a /b.jpg' },
  { name: '目录段结尾空格', file: 'a /b.jpg' },
  { name: '目录段结尾空格2', file: 'a /b.jpg' },
  { name: '整体前导空格', file: ' a/b.jpg' },
  // 保留名全集
  { name: 'PRN', file: 'prn.jpg' },
  { name: 'AUX', file: 'aux.jpg' },
  { name: 'NUL', file: 'nul.jpg' },
  { name: 'COM9', file: 'com9.jpg' },
  { name: 'COM10（不在名单）', file: 'com10.jpg' },
  { name: 'LPT9', file: 'lpt9.jpg' },
  { name: 'LPT1', file: 'lpt1.jpg' },
  { name: 'CLOCK$（老式保留名）', file: 'clock$.jpg' },
  // 只有扩展名
  { name: '纯扩展名段', file: '.jpg' },
];

/** 扩展名扫描：Shell 集成扩展名黑名单到底包含哪些 */
const EXT_SWEEP = [
  'url', 'lnk', 'scf', 'local', 'ade', 'adp', 'desktop', 'appref-ms', 'application',
  'website', 'URL', 'Url', 'LNK', 'exe', 'bat', 'cmd', 'sh', 'js', 'html', 'htm',
  'htm', 'crx', 'xpi', 'dll', 'msi', 'jar', 'vbs', 'ps1', 'com', 'pif', 'scr',
];

/** 单字符扫描：找出还有哪些字符会被拒 */
const CHAR_SWEEP = [];
for (let code = 0x20; code <= 0x7e; code += 1) {
  CHAR_SWEEP.push(String.fromCharCode(code));
}
// 常见的非 ASCII 标点与符号
for (const ch of ['、', '，', '。', '！', '？', '：', '；', '·', '—', '…', '～', '€', '£', '¥', '©', '®', '°', '±', '×', '÷', '№', '§', '¶', '†', '‡', '•', '‰', '′', '″', '‹', '›', '€']) {
  CHAR_SWEEP.push(ch);
}

let chromeProc = null;
process.on('exit', () => {
  try {
    chromeProc?.kill();
  } catch {
    /* ignore */
  }
});

async function listTargets() {
  return (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
}

/** 在某个 target 的调试连接上求值 */
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
  if (res.result?.exceptionDetails) {
    throw new Error(res.result.exceptionDetails.text || 'SW 执行异常');
  }
  return res.result?.result?.value;
}

let swTarget = null;

/**
 * 找到「我们这个扩展」的 service worker。
 * 不能只看 url 以 chrome-extension:// 开头 —— Chrome 自带组件扩展也占着 SW target，
 * 认错人就会得到 chrome.downloads is undefined。
 */
async function findOurSW() {
  if (swTarget) return swTarget;
  const targets = await listTargets();
  const workers = targets.filter(
    (t) => t.type === 'service_worker' && String(t.url || '').startsWith('chrome-extension://'),
  );
  for (const t of workers) {
    try {
      const name = await evalIn(
        t,
        `try{chrome.runtime.getManifest().name}catch(e){'?'}`,
      );
      if (name === '小红书下载器') {
        swTarget = t;
        return t;
      }
    } catch {
      /* 试下一个 */
    }
  }
  throw new Error(
    '找不到本扩展的 service worker，候选：' +
      JSON.stringify(workers.map((t) => t.url)),
  );
}

async function swEvaluate(expression) {
  const sw = await findOurSW();
  return evalIn(sw, expression);
}

async function main() {
  rmSync(profile, { recursive: true, force: true });
  mkdirSync(profile, { recursive: true });

  chromeProc = spawn(
    resolveChrome(),
    [
      `--user-data-dir=${profile}`,
      `--remote-debugging-port=${port}`,
      `--disable-extensions-except=${dist}`,
      `--load-extension=${dist}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--headless=new',
    ],
    { stdio: 'ignore' },
  );

  // 等本扩展的 SW 起来
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

  // 一个必定存在的小文件，用它当下载源
  const sourceUrl =
    'data:text/plain;base64,' + Buffer.from('x'.repeat(64)).toString('base64');

  const results = [];
  for (const c of CASES) {
    const expr = `(async()=>{
      try {
        const id = await chrome.downloads.download({
          url: ${JSON.stringify(sourceUrl)},
          filename: ${JSON.stringify(c.file)},
          conflictAction: 'uniquify',
          saveAs: false,
        });
        return JSON.stringify({ ok: true, id });
      } catch (e) {
        return JSON.stringify({ ok: false, error: String(e && e.message || e) });
      }
    })()`;
    let outcome;
    try {
      outcome = JSON.parse(await swEvaluate(expr));
    } catch (e) {
      outcome = { ok: false, error: `SW 通信失败: ${String(e)}` };
    }
    results.push({ ...c, ...outcome });
    console.log(
      `${outcome.ok ? '  ✅ 可用' : '  ❌ 被拒'}  ${c.name.padEnd(24)} ${JSON.stringify(c.file)}  ${
        outcome.ok ? '' : outcome.error
      }`,
    );
  }

  console.log('\n===== 字符扫描 =====');
  const badChars = [];
  for (const ch of CHAR_SWEEP) {
    const expr = `(async()=>{
      try {
        await chrome.downloads.download({
          url: ${JSON.stringify(sourceUrl)},
          filename: ${JSON.stringify(`a${ch}b.jpg`)},
          conflictAction: 'uniquify', saveAs: false,
        });
        return 'ok';
      } catch (e) { return String(e && e.message || e); }
    })()`;
    let res;
    try {
      res = await swEvaluate(expr);
    } catch (e) {
      res = `SW 通信失败: ${String(e)}`;
    }
    if (res !== 'ok') badChars.push({ ch, code: ch.codePointAt(0), error: res });
  }
  console.log(`扫描 ${CHAR_SWEEP.length} 个字符，被拒 ${badChars.length} 个：`);
  for (const b of badChars) {
    console.log(`  U+${b.code.toString(16).toUpperCase().padStart(4, '0')}  ${JSON.stringify(b.ch)}  → ${b.error}`);
  }

  console.log('\n===== 扩展名扫描 =====');
  const badExt = [];
  for (const ext of EXT_SWEEP) {
    const expr = `(async()=>{
      try {
        await chrome.downloads.download({
          url: ${JSON.stringify(sourceUrl)},
          filename: ${JSON.stringify(`测试.${ext}`)},
          conflictAction: 'uniquify', saveAs: false,
        });
        return 'ok';
      } catch (e) { return String(e && e.message || e); }
    })()`;
    let res;
    try {
      res = await swEvaluate(expr);
    } catch (e) {
      res = `SW 通信失败: ${String(e)}`;
    }
    if (res !== 'ok') badExt.push({ ext, error: res });
  }
  console.log(`扫描 ${EXT_SWEEP.length} 个扩展名，被拒 ${badExt.length} 个：`);
  for (const b of badExt) console.log(`  .${b.ext}  → ${b.error}`);

  console.log('\n===== 汇总 =====');
  const rejected = results.filter((r) => !r.ok);
  console.log(`可用 ${results.length - rejected.length} / 被拒 ${rejected.length}`);
  console.log('被拒规则：');
  for (const r of rejected) console.log(`  - ${r.name}  ${JSON.stringify(r.file)}  → ${r.error}`);

  // 清理下载目录里刚落的探测文件
  try {
    const list = await swEvaluate(
      `(async()=>JSON.stringify((await chrome.downloads.search({limit:100})).map(d=>d.id)))()`,
    );
    const ids = JSON.parse(list);
    await swEvaluate(
      `(async()=>{for (const id of ${JSON.stringify(ids)}) await chrome.downloads.removeFile(id).catch(()=>{}); return 'ok'})()`,
    );
  } catch {
    /* ignore */
  }

  const downloadsDir = path.join(process.env.HOME || '', 'Downloads');
  try {
    const { readdirSync } = await import('node:fs');
    for (const f of readdirSync(downloadsDir)) {
      if (/正常文件名|a:b|a\*b|a\?b|a"b|a<b|a>b|a\|b|隐藏文件|con\.jpg|COM1\.jpg|foo\./.test(f)) {
        const full = path.join(downloadsDir, f);
        try {
          if (statSync(full).isFile()) rmSync(full);
        } catch {
          /* ignore */
        }
      }
    }
  } catch {
    /* ignore */
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
