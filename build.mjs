import { build, context } from 'esbuild';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

const root = path.dirname(new URL(import.meta.url).pathname);
const outdir = path.join(root, 'dist');
const watch = process.argv.includes('--watch');

/**
 * 主题变量（颜色、字体、阴影、圆角）的唯一来源：src/shared/palette.json。
 *
 * popup / options / 内容脚本面板三处都从这里取值 —— 以前各写一份，
 * 改一次漏两处，「说明文字对比度不足」就是这么来的。
 */
const palette = JSON.parse(await readFile(path.join(root, 'src/shared/palette.json'), 'utf8'));

function varsBlock(colors) {
  return Object.entries(colors)
    .map(([name, value]) => `  ${name}: ${value};`)
    .join('\n');
}

function themeCss() {
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

/** esbuild 把每个入口打成独立 IIFE，避免 content script / SW 的模块解析差异 */
const entryPoints = {
  content: path.join(root, 'src/content/index.ts'),
  'page-hook': path.join(root, 'src/content/page-hook.ts'),
  background: path.join(root, 'src/background/index.ts'),
  offscreen: path.join(root, 'src/offscreen/index.ts'),
  popup: path.join(root, 'src/popup/index.ts'),
  options: path.join(root, 'src/options/index.ts'),
};

const common = {
  bundle: true,
  format: 'iife',
  target: ['chrome114'],
  platform: 'browser',
  sourcemap: true,
  minify: false,
  legalComments: 'none',
  logLevel: 'info',
  define: { 'process.env.NODE_ENV': '"production"' },
};

async function copyStatic() {
  await cp(path.join(root, 'public'), outdir, { recursive: true });
  // 主题变量从 palette.json 生成 —— popup.html / options.html 引用的就是它
  await writeFile(path.join(outdir, 'theme.css'), themeCss());
}

async function run() {
  await rm(outdir, { recursive: true, force: true });
  await mkdir(outdir, { recursive: true });

  if (watch) {
    const ctxs = await Promise.all(
      Object.entries(entryPoints).map(async ([name, entry]) =>
        context({
          ...common,
          entryPoints: [entry],
          outfile: path.join(outdir, `${name}.js`),
        }),
      ),
    );
    await Promise.all(ctxs.map((c) => c.watch()));
    await copyStatic();
    console.log('[build] watching…');
    return;
  }

  await Promise.all(
    Object.entries(entryPoints).map(([name, entry]) =>
      build({
        ...common,
        entryPoints: [entry],
        outfile: path.join(outdir, `${name}.js`),
      }),
    ),
  );
  await copyStatic();
  console.log('[build] done →', outdir);
}

if (!existsSync(path.join(root, 'src/content/index.ts'))) {
  console.warn('[build] source entry missing; nothing to build');
}
await run();
