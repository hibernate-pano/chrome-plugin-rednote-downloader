import { build, context } from 'esbuild';
import { cp, mkdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

const root = path.dirname(new URL(import.meta.url).pathname);
const outdir = path.join(root, 'dist');
const watch = process.argv.includes('--watch');

/** esbuild 把每个入口打成独立 IIFE，避免 content script / SW 的模块解析差异 */
const entryPoints = {
  content: path.join(root, 'src/content/index.ts'),
  'page-hook': path.join(root, 'src/content/page-hook.ts'),
  background: path.join(root, 'src/background/index.ts'),
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
