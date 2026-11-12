/**
 * 核对：色值改成单一来源之后，**渲染出来的颜色必须一模一样**。
 *
 * 逐来源比对，不合并 —— 合并会掩盖「某个来源少了某个变量」这种差异。
 * 对比对象是改动前（git HEAD）的三处变量声明 vs 现在的 palette.json。
 *
 * 字体栈单独查：它没进 palette，应该原地不动。
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

function head(file) {
  return execFileSync('git', ['show', `HEAD:${file}`], { cwd: root, encoding: 'utf8' });
}

/** 从一段 CSS 里抠出某个选择器块里的变量 */
function varsOf(css, selector) {
  const out = {};
  const re = new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`, 'g');
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
  return value
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

const palette = JSON.parse(fs.readFileSync(path.join(root, 'src/shared/palette.json'), 'utf8'));
const newLight = palette.light;
const newDark = palette.dark;

// ── 改动前的三处 ──────────────────────────────────────────────
const popup = head('public/popup.css');
const options = head('public/options.css');
const styles = head('src/content/ui/styles.ts');

const popupLight = varsOf(popup.slice(0, popup.indexOf('@media')), ':root');
const popupDark = varsOf(popup.slice(popup.indexOf('@media')), ':root');
const optionsLight = varsOf(options.slice(0, options.indexOf('@media')), ':root');
const optionsDark = varsOf(options.slice(options.indexOf('@media')), ':root');
const stylesLight = varsOf(styles.slice(0, styles.indexOf(':host([data-theme="dark"])')), ':host');
const stylesDark = varsOf(
  styles
    .slice(styles.indexOf(':host([data-theme="dark"])'))
    .replace(':host([data-theme="dark"])', ':host-dark'),
  ':host-dark',
);

// ── 改动后的三处 ──────────────────────────────────────────────
const popupNow = fs.readFileSync(path.join(root, 'public/popup.css'), 'utf8');
const optionsNow = fs.readFileSync(path.join(root, 'public/options.css'), 'utf8');
const stylesNow = fs
  .readFileSync(path.join(root, 'src/content/ui/styles.ts'), 'utf8')
  // 模板表达式里的 } 会把 CSS 块的正则截断 —— 先抹掉
  .replace(/\$\{vars\(palette\.(light|dark)\)\}/g, '');

let bad = 0;
function check(label, name, expected, actual, where) {
  if (actual === undefined) {
    console.log(`❌ ${label} ${name}：${where} 里没了（原 ${expected}）`);
    bad += 1;
    return;
  }
  if (norm(expected) !== norm(actual)) {
    console.log(`❌ ${label} ${name}：${expected} → ${actual}（${where}）`);
    bad += 1;
  }
}

// 颜色：每个来源的每个变量都必须在 palette 里存在且一致（--font 除外，它原地不动）
for (const [label, set, target] of [
  ['popup 浅色', popupLight, newLight],
  ['popup 深色', popupDark, newDark],
  ['options 浅色', optionsLight, newLight],
  ['options 深色', optionsDark, newDark],
  ['面板 浅色', stylesLight, newLight],
  ['面板 深色', stylesDark, newDark],
]) {
  for (const [name, value] of Object.entries(set)) {
    if (name === '--font') continue;
    check(label, name, value, target[name], 'palette.json');
  }
}

// 字体：必须原地保留，值不变
check('popup', '--font', popupLight['--font'], varsOf(popupNow, ':root')['--font'], 'popup.css');
check('options', '--font', optionsLight['--font'], varsOf(optionsNow, ':root')['--font'], 'options.css');
check(
  '面板',
  '--font',
  stylesLight['--font'],
  varsOf(stylesNow.slice(0, stylesNow.indexOf(':host([data-theme="dark"])')), ':host')['--font'],
  'styles.ts',
);

// 反向检查：palette 里的每个变量都有人用（不是凭空多出来的）
const used = new Set([
  ...Object.keys(popupLight),
  ...Object.keys(optionsLight),
  ...Object.keys(stylesLight),
]);
const orphans = Object.keys(newLight).filter((n) => !used.has(n));
if (orphans.length) console.log(`· palette 里没人用的变量：${orphans.join(', ')}`);

console.log(
  bad === 0
    ? `✅ 颜色零变化：popup/options/面板 三处共 ${
        Object.keys(popupLight).length +
        Object.keys(optionsLight).length +
        Object.keys(stylesLight).length
      } 项浅色 + 对应深色全部一致，字体栈也没动`
    : `❌ ${bad} 项不一致`,
);
process.exit(bad === 0 ? 0 : 1);
