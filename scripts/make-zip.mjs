/**
 * 打商店上传用的 zip。
 *
 * 商店只认「根目录就是 manifest.json」的包，所以要从 dist/ 里面压，不能连 dist 一起压。
 * 三类东西必须排除，压进去会出问题：
 *   - sourcemap（几十 MB，审核看到的也是它）
 *   - .DS_Store（macOS 番外，之前真混进去过一次）
 *   - 源码与 node_modules（根本不该出现在 dist 里，出现了就是构建配置坏了）
 *
 * 用法：node scripts/make-zip.mjs   （或 pnpm release:zip，会先构建）
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const dist = path.join(root, 'dist');
const outDir = path.join(root, 'out');
const outFile = path.join(outDir, 'extension.zip');

if (!fs.existsSync(path.join(dist, 'manifest.json'))) {
  console.error('❌ dist/manifest.json 不存在 —— 先跑 node build.mjs');
  process.exit(1);
}

const version = JSON.parse(fs.readFileSync(path.join(dist, 'manifest.json'), 'utf8')).version;

fs.rmSync(outFile, { force: true });
fs.mkdirSync(outDir, { recursive: true });

execFileSync(
  'zip',
  ['-qr', outFile, '.', '-x', '*.map', '-x', '.DS_Store', '-x', '__MACOSX/*'],
  { cwd: dist, stdio: 'inherit' },
);

const listing = execFileSync('unzip', ['-l', outFile], { encoding: 'utf8' });
const names = listing
  .split('\n')
  .map((line) => line.trim().split(/\s+/).slice(3).join(' '))
  .filter(Boolean);

const junk = names.filter((n) => /\.map$|\.ts$|DS_Store|node_modules|^src\//.test(n));
if (junk.length > 0) {
  console.error(`❌ zip 里混进了不该有的东西：${junk.join(', ')}`);
  process.exit(1);
}
if (!names.includes('manifest.json')) {
  console.error('❌ zip 根目录没有 manifest.json —— 商店会拒收');
  process.exit(1);
}

console.log(`✅ out/extension.zip  v${version}  ${(fs.statSync(outFile).size / 1024).toFixed(0)}KB  ${names.length} 项`);
