/**
 * 守住「配色只有一个来源」这条契约。
 *
 * 背景：popup.css / options.css / 内容脚本面板原来各写一份颜色变量。
 * 有一次只改了两处，「说明文字对比度不足」就来了 —— 因为漏的那一处没人发现。
 * 现在颜色只写在 src/shared/palette.json，theme.css 由它生成。
 *
 * 默认查三件事（都不依赖 git 历史，任何时候都能跑）：
 *   1. dist/theme.css 跟 palette.json 对得上（改了 palette 忘了重建会红）
 *   2. 三个样式文件里不再重复定义 palette 管着的变量
 *   3. var(--x) 引用的变量真的存在（palette 里删了变量却还在用会红）
 *
 * 重构配色时额外加 --against <rev>：拿改动前的声明逐项比对，
 * 确认「颜色一个字节都没变」。写法不同但数值相同算一致（0.10 和 .1 是同一个数）。
 *
 * 用法：
 *   node scripts/check-palette.mjs
 *   node scripts/check-palette.mjs --against 58ad30d
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const palette = JSON.parse(fs.readFileSync(path.join(root, 'src/shared/palette.json'), 'utf8'));

/** 本地自己定义的、不属于 palette 的变量 */
const LOCAL_ONLY = new Set(['--font']);

const paletteNames = new Set([...Object.keys(palette.light), ...Object.keys(palette.dark)]);

const files = {
  'public/popup.css': fs.readFileSync(path.join(root, 'public/popup.css'), 'utf8'),
  'public/options.css': fs.readFileSync(path.join(root, 'public/options.css'), 'utf8'),
  'src/content/ui/styles.ts': fs.readFileSync(path.join(root, 'src/content/ui/styles.ts'), 'utf8'),
};

let bad = 0;
const fail = (msg) => {
  console.log(`❌ ${msg}`);
  bad += 1;
};

/* ------------------------------------------------------------------ */
/* 1. theme.css 跟 palette.json 对得上吗                              */
/* ------------------------------------------------------------------ */

function varsBlock(colors) {
  return Object.entries(colors)
    .map(([name, value]) => `  ${name}: ${value};`)
    .join('\n');
}

/** 跟 build.mjs 里的 themeCss() 必须产出完全一样的东西 */
function expectedTheme() {
  return `/* 自动生成 —— 不要手改。
   改配色请改 src/shared/palette.json，然后重新构建。 */

:root {
${varsBlock(palette.light)}
}

@media (prefers-color-scheme: dark) {
  :root {
${varsBlock(palette.dark)}
  }
}
`;
}

const themePath = path.join(root, 'dist/theme.css');
if (!fs.existsSync(themePath)) {
  fail('dist/theme.css 不存在 —— 先跑 node build.mjs');
} else if (fs.readFileSync(themePath, 'utf8') !== expectedTheme()) {
  fail('dist/theme.css 跟 palette.json 对不上 —— 改了配色没重新构建，或者有人手改了 dist');
}

/* ------------------------------------------------------------------ */
/* 2. 三个样式文件里不许重复定义 palette 管着的变量                    */
/* ------------------------------------------------------------------ */

for (const [file, css] of Object.entries(files)) {
  const re = /(--[\w-]+)\s*:/g;
  let m;
  const dupes = new Set();
  while ((m = re.exec(css)) !== null) {
    const name = m[1];
    // styles.ts 里的 `${vars(palette.light)}` 不是字面定义，跳过
    if (paletteNames.has(name) && !LOCAL_ONLY.has(name)) dupes.add(name);
  }
  if (dupes.size > 0) {
    fail(`${file} 里又写了一遍 ${[...dupes].join(', ')} —— 这些应该只在 palette.json 里`);
  }
}

/* ------------------------------------------------------------------ */
/* 3. var(--x) 引用的变量真的存在吗                                   */
/* ------------------------------------------------------------------ */

const known = new Set([...paletteNames, ...LOCAL_ONLY]);
for (const [file, css] of Object.entries(files)) {
  // 带 fallback 的引用（var(--x, ...)）不算错：那是「没有就用默认值」的有意写法
  const re = /var\(\s*(--[\w-]+)\s*\)/g;
  let m;
  const missing = new Set();
  while ((m = re.exec(css)) !== null) {
    if (!known.has(m[1])) missing.add(m[1]);
  }
  if (missing.size > 0) {
    fail(`${file} 用了不存在的变量 ${[...missing].join(', ')}`);
  }
}

/* ------------------------------------------------------------------ */
/* 可选：跟某个历史版本逐项比对颜色                                     */
/* ------------------------------------------------------------------ */

const againstAt = process.argv.indexOf('--against');
if (againstAt !== -1) {
  const rev = process.argv[againstAt + 1];
  if (!rev) {
    fail('--against 后面要跟一个 git 版本');
  } else {
    const head = (file) =>
      execFileSync('git', ['show', `${rev}:${file}`], { cwd: root, encoding: 'utf8' });

    /** 从一段 CSS 里抠出某个选择器块里的变量 */
    function varsOf(css, selector) {
      const out = {};
      const re = new RegExp(
        `${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`,
        'g',
      );
      let m;
      while ((m = re.exec(css)) !== null) {
        const vre = /(--[\w-]+)\s*:\s*([^;]+);/g;
        let v;
        while ((v = vre.exec(m[1])) !== null) out[v[1]] = v[2].trim();
      }
      return out;
    }

    /** 归一化：写法不同但数值相同的一律算一致 */
    function norm(value) {
      return String(value ?? '')
        .trim()
        .toLowerCase()
        .replace(/"/g, "'")
        .replace(/\s+/g, '')
        .replace(/(\d*)\.(\d+)/g, (_, int, frac) => {
          const trimmed = frac.replace(/0+$/, '');
          const head = int === '' ? '0' : int;
          return trimmed ? `${head}.${trimmed}` : head;
        });
    }

    const popup = head('public/popup.css');
    const options = head('public/options.css');
    const stylesHead = head('src/content/ui/styles.ts');

    const sets = [
      ['popup 浅色', varsOf(popup.slice(0, popup.indexOf('@media')), ':root'), palette.light],
      ['popup 深色', varsOf(popup.slice(popup.indexOf('@media')), ':root'), palette.dark],
      ['options 浅色', varsOf(options.slice(0, options.indexOf('@media')), ':root'), palette.light],
      ['options 深色', varsOf(options.slice(options.indexOf('@media')), ':root'), palette.dark],
      [
        '面板 浅色',
        varsOf(stylesHead.slice(0, stylesHead.indexOf(':host([data-theme="dark"])')), ':host'),
        palette.light,
      ],
      [
        '面板 深色',
        varsOf(
          stylesHead
            .slice(stylesHead.indexOf(':host([data-theme="dark"])'))
            .replace(':host([data-theme="dark"])', ':host-dark'),
          ':host-dark',
        ),
        palette.dark,
      ],
    ];

    for (const [label, oldSet, target] of sets) {
      for (const [name, value] of Object.entries(oldSet)) {
        if (LOCAL_ONLY.has(name)) continue;
        if (!(name in target)) {
          fail(`${label} ${name}：改动后没了（原 ${value}）`);
        } else if (norm(value) !== norm(target[name])) {
          fail(`${label} ${name}：${value} → ${target[name]}`);
        }
      }
    }

    // 字体栈没进 palette，应该原地不动
    const fontNow = varsOf(files['public/popup.css'], ':root')['--font'];
    if (norm(varsOf(popup.slice(0, popup.indexOf('@media')), ':root')['--font']) !== norm(fontNow)) {
      fail('popup.css 的字体栈变了');
    }

    if (bad === 0) console.log(`· 已跟 ${rev} 逐项比对，颜色零变化`);
  }
}

console.log(
  bad === 0
    ? `✅ 配色契约成立：${paletteNames.size} 个变量只有 palette.json 一个来源，theme.css 与之一致`
    : `❌ ${bad} 项不合规`,
);
process.exit(bad === 0 ? 0 : 1);
