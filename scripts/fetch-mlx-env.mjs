// 构建期获取 macOS MLX 离线运行环境到 resources-mlx/（extraResources 进包）：
//   python.tar.gz —— python-build-standalone（aarch64-apple-darwin，可重定位）
//   wheels/       —— mlx + mlx-embeddings + transformers 及依赖（uv pip download）
// 打包后的应用首次使用 MLX 时离线置备 venv（见 server/rag/embed.js）。
// 用法：node scripts/fetch-mlx-env.mjs   （已存在则跳过；--force 重拉）
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const OUT = path.join(ROOT, 'resources-mlx');
const force = process.argv.includes('--force');

fs.mkdirSync(path.join(OUT, 'wheels'), { recursive: true });

// ---- 1. python-build-standalone ----
// 固定版本与校验和：构建可复现，且不走匿名限流的 api.github.com（CI 共享出口 IP 常被限流）
const PY_RELEASE = '20261013';
const PY_ASSET = `cpython-3.12.15+${PY_RELEASE}-aarch64-apple-darwin-install_only.tar.gz`;
const PY_SHA256 = 'ba32036ad8f4c434d97a1ee7feef8b7edc0fac16777639b97e39c74a108e4440';

async function fetchPython() {
  const dest = path.join(OUT, 'python.tar.gz');
  if (fs.existsSync(dest) && !force) return console.log('python.tar.gz 已存在，跳过');
  console.log('下载', PY_ASSET);
  const r = await fetch(`https://github.com/astral-sh/python-build-standalone/releases/download/${PY_RELEASE}/${encodeURIComponent(PY_ASSET)}`);
  if (!r.ok) throw new Error(`下载 ${PY_ASSET} 失败: HTTP ${r.status}`);
  const buf = Buffer.from(await r.arrayBuffer());
  const sha = crypto.createHash('sha256').update(buf).digest('hex');
  if (sha !== PY_SHA256) throw new Error(`${PY_ASSET} 校验和不符: ${sha}`);
  fs.writeFileSync(dest, buf);
}

// ---- 2. wheels（uv pip download，按 macOS arm64 + cp312 解析） ----
function fetchWheels() {
  // 按 resources-mlx/requirements.txt 逐包 --no-deps 下载（最小集，与 sidecar 实证对齐）
  const reqFile = path.join(OUT, 'requirements.txt');
  const pinned = fs.readFileSync(reqFile, 'utf8').split('\n')
    .filter((l) => l && !l.startsWith('#'))
    .map((l) => l.trim().replace('_', '-'));
  const have = new Set(fs.readdirSync(path.join(OUT, 'wheels')).filter((f) => f.endsWith('.whl')));
  if (have.size >= pinned.length && !force) return console.log('wheels 已存在（' + have.size + ' 个），跳过');
  // mlx 的 mac wheel 从 macosx_14_0 起，多标签让 pip 全都可匹配
  const platforms = ['--platform', 'macosx_14_0_arm64', '--platform', 'macosx_15_0_arm64', '--platform', 'macosx_26_0_arm64'];
  const seedEnv = path.join(OUT, '.seed-venv');
  let r = spawnSync('uv', ['venv', '--clear', '--seed', '--python', '3.12', seedEnv], { stdio: 'inherit' });
  if (r.status !== 0) throw new Error('seed venv 失败');
  const pip = path.join(seedEnv, 'bin', 'pip');
  for (const pkg of pinned) {
    r = spawnSync(pip, ['download', '--no-deps', pkg, '-d', path.join(OUT, 'wheels'),
      '--python-version', '312', ...platforms, '--only-binary=:all:'], { stdio: 'inherit' });
    if (r.status !== 0) throw new Error('pip download 失败: ' + pkg);
  }
  fs.rmSync(seedEnv, { recursive: true, force: true });
}

await fetchPython();
fetchWheels();
const total = fs.readdirSync(OUT).length;
const size = fs.readdirSync(path.join(OUT, 'wheels')).reduce((s, f) => s + fs.statSync(path.join(OUT, 'wheels', f)).size, 0)
  + (fs.existsSync(path.join(OUT, 'python.tar.gz')) ? fs.statSync(path.join(OUT, 'python.tar.gz')).size : 0);
console.log(`MLX 环境就绪：python.tar.gz + wheels，合计 ${(size / 1048576).toFixed(1)}MB`);
