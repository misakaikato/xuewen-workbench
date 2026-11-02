// 分进程运行日志：同步追加写文件（任何异常吞掉、绝不抛出），并接管本进程 console 输出。
import fs from 'node:fs';
import path from 'node:path';
import util from 'node:util';

export function logsDir(dataDir) {
  return path.join(dataDir, 'logs');
}

// 单条日志上限：超过则截断并标注截断字符数
const MAX_LINE = 8000;

function formatLine(level, tag, message) {
  let m = String(message);
  if (m.length > MAX_LINE) {
    m = m.slice(0, MAX_LINE) + '…(截断 ' + (String(message).length - MAX_LINE) + ' 字符)';
  }
  const body = m
    .split('\n')
    .map((line, i) => (i === 0 ? line : '  ' + line))
    .join('\n');
  return new Date().toISOString() + ' ' + level.padEnd(5) + ' [' + tag + '] ' + body + '\n';
}

export function createLogWriter({ dir, name, maxBytes = 5 * 1024 * 1024, keep = 3 }) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name + '.log');
  let size = 0;
  try { size = fs.statSync(file).size; } catch { /* 新文件 */ }

  function rotate() {
    try {
      const last = path.join(dir, name + '.log.' + (keep - 1));
      if (fs.existsSync(last)) fs.rmSync(last, { force: true });
      for (let i = keep - 2; i >= 1; i--) {
        const from = path.join(dir, name + '.log.' + i);
        if (fs.existsSync(from)) fs.renameSync(from, path.join(dir, name + '.log.' + (i + 1)));
      }
      if (fs.existsSync(file)) fs.renameSync(file, path.join(dir, name + '.log.1'));
    } catch { /* 轮转失败静默 */ }
    size = 0;
  }

  function write(level, tag, message) {
    try {
      const line = formatLine(level, tag, message);
      const bytes = Buffer.byteLength(line, 'utf8');
      if (size + bytes > maxBytes) rotate();
      fs.appendFileSync(file, line, 'utf8');
      size += bytes;
    } catch { /* 写入失败静默，绝不抛出 */ }
  }

  return { file, write };
}

export function initProcessLogger({ dir, name, tag }) {
  const writer = createLogWriter({ dir, name });
  const methods = [
    ['log', 'INFO'], ['info', 'INFO'], ['warn', 'WARN'], ['error', 'ERROR'], ['debug', 'DEBUG'],
  ];
  for (const [m, level] of methods) {
    const original = console[m].bind(console);
    console[m] = (...args) => {
      try { writer.write(level, tag, util.format(...args)); } catch { /* 绝不抛 */ }
      original(...args);
    };
  }
  process.on('uncaughtExceptionMonitor', (err, origin) => {
    try {
      const text = err && err.stack ? err.stack : String(err);
      writer.write('FATAL', tag, '未捕获异常(' + (origin || 'unknown') + '): ' + text);
    } catch { /* 绝不抛 */ }
  });
  return writer;
}
