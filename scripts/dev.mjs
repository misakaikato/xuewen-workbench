// 开发启动器：同时启动后端 API 与 Vite 前端，转发 CLI 参数（--port/--host）给 Vite
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const args = process.argv.slice(2);

const server = spawn(process.execPath, [path.join(root, 'server', 'index.js')], {
  stdio: 'inherit',
  cwd: root,
});

const viteBin = path.join(root, 'node_modules', 'vite', 'bin', 'vite.js');
const client = spawn(process.execPath, [viteBin, ...args], { stdio: 'inherit', cwd: root });

function shutdown() {
  server.kill();
  client.kill();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
client.on('exit', (code) => {
  server.kill();
  process.exit(code ?? 0);
});
