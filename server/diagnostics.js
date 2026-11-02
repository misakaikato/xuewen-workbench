// 异常事件记录与诊断包导出：session 运行标记、incidents 追加、诊断 zip 生成（只导出不上传）。
import fs from 'node:fs';
import path from 'node:path';
import { logsDir } from './logger.js';
import { writeZip } from './zip.js';

const LOG_CAP = 30 * 1024 * 1024; // 日志收录总量上限 30MB

const sessionFile = (dataDir) => path.join(logsDir(dataDir), 'session.json');
const incidentsFile = (dataDir) => path.join(logsDir(dataDir), 'incidents.jsonl');
const ackFile = (dataDir) => path.join(logsDir(dataDir), 'incident-ack.json');

export function appendIncident(dataDir, incident) {
  try {
    const dir = logsDir(dataDir);
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(incidentsFile(dataDir), JSON.stringify(incident) + '\n', 'utf8');
  } catch { /* 写失败静默 */ }
}

export function readIncidents(dataDir, { limit = 50 } = {}) {
  const out = [];
  try {
    const raw = fs.readFileSync(incidentsFile(dataDir), 'utf8');
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try { out.push(JSON.parse(line)); } catch { /* 坏行跳过 */ }
    }
  } catch { /* 无文件 */ }
  return out.slice(-limit);
}

export function pendingIncident(dataDir) {
  let ackAt = '';
  try {
    const ack = JSON.parse(fs.readFileSync(ackFile(dataDir), 'utf8'));
    if (ack && typeof ack.at === 'string') ackAt = ack.at;
  } catch { /* 未 ack */ }
  const list = readIncidents(dataDir);
  for (let i = list.length - 1; i >= 0; i--) {
    if (list[i] && typeof list[i].at === 'string' && list[i].at > ackAt) return list[i];
  }
  return null;
}

export function ackIncidents(dataDir) {
  try {
    const dir = logsDir(dataDir);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(ackFile(dataDir), JSON.stringify({ at: new Date().toISOString() }), 'utf8');
  } catch { /* 静默 */ }
}

export function markSessionStart(dataDir, info) {
  try {
    const dir = logsDir(dataDir);
    fs.mkdirSync(dir, { recursive: true });
    const sf = sessionFile(dataDir);
    if (fs.existsSync(sf)) {
      let detail = { raw: '无法解析' };
      try { detail = JSON.parse(fs.readFileSync(sf, 'utf8')); } catch { /* 保持 raw */ }
      appendIncident(dataDir, { kind: 'unclean-exit', at: new Date().toISOString(), detail });
    }
    fs.writeFileSync(sf, JSON.stringify(info), 'utf8');
  } catch { /* 静默 */ }
}

export function markSessionEnd(dataDir) {
  try { fs.rmSync(sessionFile(dataDir), { force: true }); } catch { /* 不存在不报错 */ }
}

function localStamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
}

function readme(dataDir) {
  return [
    '学问 Workbench 诊断包',
    '',
    '包含内容：',
    '- 运行日志（logs/ 下的 main.log、backend.log、renderer.log 及其轮转文件）',
    '- 异常事件记录（logs/incidents.jsonl）',
    '- 环境与资料库统计（summary.json）',
    '',
    '不包含：文档正文、对话内容、LLM 提示词与回复、API Key、LLM 端点地址。',
    '',
    '数据目录：' + dataDir,
    '日志目录：' + logsDir(dataDir),
    '',
  ].join('\n');
}

function collectLogs(dataDir) {
  const dir = logsDir(dataDir);
  let names = [];
  try {
    names = fs.readdirSync(dir).filter((n) => /\.log(\.\d+)?$/.test(n) || n === 'incidents.jsonl');
  } catch { /* 无日志目录 */ }
  const stats = names
    .map((n) => {
      try { return { n, mtime: fs.statSync(path.join(dir, n)).mtimeMs }; } catch { return { n, mtime: 0 }; }
    })
    .sort((a, b) => b.mtime - a.mtime);
  const entries = [];
  let remaining = LOG_CAP;
  for (const { n } of stats) {
    if (remaining <= 0) break;
    let data;
    try { data = fs.readFileSync(path.join(dir, n)); } catch { continue; }
    let head = Buffer.alloc(0);
    let body = data;
    if (data.length > remaining) {
      const skip = data.length - remaining;
      head = Buffer.from('…(前 ' + skip + ' 字节已省略)\n', 'utf8');
      body = data.subarray(skip);
    }
    entries.push({ name: 'logs/' + n, data: Buffer.concat([head, body]) });
    remaining -= body.length;
  }
  return entries;
}

export async function exportDiagnostics({ dataDir, outDir, summary }) {
  let dir = outDir;
  let ok = false;
  if (dir) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.accessSync(dir, fs.constants.W_OK);
      ok = true;
    } catch { /* 回退到数据目录下 */ }
  }
  if (!ok) {
    dir = path.join(dataDir, 'diagnostics');
    fs.mkdirSync(dir, { recursive: true });
  }
  const file = path.join(dir, '学问Workbench-诊断-' + localStamp() + '.zip');
  const entries = [
    { name: 'summary.json', data: Buffer.from(JSON.stringify({ ...summary, generatedAt: new Date().toISOString() }, null, 2), 'utf8') },
    { name: '说明.txt', data: Buffer.from(readme(dataDir), 'utf8') },
    ...collectLogs(dataDir),
  ];
  await writeZip(file, entries);
  return { file };
}
