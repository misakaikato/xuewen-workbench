// 启动清理：中断留下的临时文件与目录、另一后端的模型半截文件、备份与 incidents 上限、
// 停在 .trash 中转里的删除批次、不再被引用的模型会话文件。
// 后端就绪后延迟执行一次，全程异步，每处理 50 个条目让出一次事件循环。
// 只认下面列出的本应用命名规则与自有目录，其余文件一律不碰；单项失败记 WARN 后继续。
import fs from 'node:fs';
import path from 'node:path';
import { TRASH_DIR } from './scanner.js';
import { getTrashHandler } from './trash.js';
import { capIncidents } from './diagnostics.js';
import { withActivity } from './lagWatch.js';
import { PI_SESSION_FILE } from './agent/manager.js';

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;
const YIELD_EVERY = 50;
const BACKUPS_PER_DOC = 20;
const BACKUPS_MAX_BYTES = 500 * 1024 * 1024;
// 测试可用 WORKBENCH_SWEEP_DELAY_MS 缩短延迟
const DELAY_MS = (() => {
  const v = Number(process.env.WORKBENCH_SWEEP_DELAY_MS);
  return process.env.WORKBENCH_SWEEP_DELAY_MS && Number.isFinite(v) && v >= 0 ? v : 30000;
})();

// ---------- 命名规则（各自的写入方见注释） ----------

// 数据目录：原子写临时文件 <名>.tmp-<pid>[-<序号>]（atomicFile.js、agent/memory.js、zip.js）
const DATA_TMP_FILE = /\.tmp-\d+(?:-\d+)?$/;
// Word 转换临时目录 knowledge/<dsId>/cache/convert-<6 位>（word.js mkdtemp）
const CONVERT_DIR = /^convert-[A-Za-z0-9]{6}$/;
// skill 安装临时目录 agents/<id>/skills/.<名>.tmp-<十六进制>（agent/routes.js）
const SKILL_TMP_DIR = /^\..+\.tmp-[0-9a-f]+$/;
// 数据目录下不进入的顶层目录：模型（.part 按后端单独处理）、第三方 Python 环境
const DATA_SKIP_TOP = new Set(['models', 'py']);
// 资料库：保存、旁注写入的临时文件 <名>.wb-tmp-<pid>[-<序号>]（index.js、meta.js）
const LIB_TMP_FILE = /\.wb-tmp-\d+(?:-\d+)?$/;
// 复制中的隐藏副本 .<名>.wb-copy-<时间戳>，文件或目录（index.js 复制）
const LIB_COPY = /^\..+\.wb-copy-\d+$/;
// 仅大小写改名的中间名 <原名>.wb-case-<12 位十六进制>（index.js relocate）：
// 它就是被改名的条目本身，不删，原名空着时改回原名
const LIB_CASE = /^(.+)\.wb-case-[0-9a-f]{12}$/;
// 备份 <文档名>.<ISO 时间戳，: 与 . 换成 ->.bak（index.js 保存）
const BACKUP_NAME = /^(.+)\.(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)\.bak$/;
// 删除批次目录 <yyyymmdd-hhmmss-mmm>[-n]__<名称>（index.js trashStamp）
const TRASH_BATCH = /^\d{8}-\d{6}-\d{3}(?:-\d+)?__./;

const SUMMARY_LIST_MAX = 30;

const toSlash = (p) => p.split(path.sep).join('/');

function createSweep() {
  let seen = 0;
  const counts = new Map(); // 类别 -> 条数
  const items = []; // 处理过的条目（展示用路径）
  const skipped = [];
  return {
    counts,
    items,
    skipped,
    async tick() {
      if (++seen % YIELD_EVERY === 0) await new Promise((r) => setImmediate(r));
    },
    note(kind, label, n = 1) {
      counts.set(kind, (counts.get(kind) || 0) + n);
      if (label) items.push(label);
    },
  };
}

async function olderThan(abs, ms) {
  try {
    return Date.now() - (await fs.promises.lstat(abs)).mtimeMs > ms;
  } catch {
    return false;
  }
}

async function remove(sw, abs, kind, label) {
  try {
    await fs.promises.rm(abs, { recursive: true, force: true });
    sw.note(kind, label);
    return true;
  } catch (e) {
    console.warn(`[sweep] 删除失败 ${label}：${e.code || e.message}`);
    return false;
  }
}

// 数据目录：递归（不进 models/、py/，不跟随符号链接），删超过 1 小时的临时文件、转换目录、skill 安装临时目录
async function sweepDataDir(sw, dataDir) {
  const stack = [''];
  while (stack.length) {
    const rel = stack.pop();
    let ents;
    try {
      ents = await fs.promises.readdir(path.join(dataDir, rel), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of ents) {
      await sw.tick();
      const childRel = rel ? rel + '/' + ent.name : ent.name;
      const abs = path.join(dataDir, childRel);
      if (ent.isDirectory()) {
        if (!rel && DATA_SKIP_TOP.has(ent.name)) continue;
        const segs = childRel.split('/');
        const isConvert = segs.length === 4 && segs[0] === 'knowledge' && segs[2] === 'cache' && CONVERT_DIR.test(segs[3]);
        const isSkillTmp = segs.length === 4 && segs[0] === 'agents' && segs[2] === 'skills' && SKILL_TMP_DIR.test(segs[3]);
        if (isConvert || isSkillTmp) {
          if (await olderThan(abs, HOUR)) await remove(sw, abs, isConvert ? '转换目录' : 'skill 安装残留', childRel);
          continue;
        }
        stack.push(childRel);
      } else if (ent.isFile() && DATA_TMP_FILE.test(ent.name)) {
        if (await olderThan(abs, HOUR)) await remove(sw, abs, '临时文件', childRel);
      }
    }
  }
}

// 大小写改名中断的条目：原名空着就改回原名，被占用则保留原样
async function restoreCaseRename(sw, abs, label) {
  const orig = path.join(path.dirname(abs), LIB_CASE.exec(path.basename(abs))[1]);
  try {
    await fs.promises.lstat(orig);
    console.warn(`[sweep] 大小写改名中断的条目 ${label} 的原名已被占用，保留原样`);
    return;
  } catch (e) {
    if (e.code !== 'ENOENT') {
      console.warn(`[sweep] 无法检查 ${label} 的原名：${e.code || e.message}`);
      return;
    }
  }
  try {
    await fs.promises.rename(abs, orig);
    sw.note('恢复大小写改名中断的条目', `${label} → ${path.basename(orig)}`);
  } catch (e) {
    console.warn(`[sweep] 恢复大小写改名中断的条目失败 ${label}：${e.code || e.message}`);
  }
}

// 资料库目录：只走非隐藏目录（隐藏副本本身在父目录里匹配），不跟随符号链接，
// 只处理超过 1 小时、符合本应用命名规则的条目
async function sweepLibrary(sw, lib) {
  const stack = [lib.baseDir];
  while (stack.length) {
    const dir = stack.pop();
    let ents;
    try {
      ents = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of ents) {
      await sw.tick();
      const isDir = ent.isDirectory();
      if (!isDir && !ent.isFile()) continue;
      const abs = path.join(dir, ent.name);
      const label = lib.name + '/' + toSlash(path.relative(lib.baseDir, abs));
      if (LIB_CASE.test(ent.name)) {
        if (await olderThan(abs, HOUR)) await restoreCaseRename(sw, abs, label);
      } else if (LIB_COPY.test(ent.name) || (!isDir && LIB_TMP_FILE.test(ent.name))) {
        if (await olderThan(abs, HOUR)) await remove(sw, abs, '库内临时文件', label);
      } else if (isDir && !ent.name.startsWith('.')) {
        stack.push(abs);
      }
    }
  }
}

// RAG 模型目录：另一后端的 .part 不会再被续传；下载或导入进行中时不动
async function sweepForeignParts(sw, embed, dataDir) {
  if (!embed) return;
  const stack = [embed.foreignModelDir()];
  while (stack.length) {
    const dir = stack.pop();
    let ents;
    try {
      ents = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of ents) {
      await sw.tick();
      const abs = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        stack.push(abs);
      } else if (ent.isFile() && ent.name.endsWith('.part')) {
        if (embed.busy()) return;
        await remove(sw, abs, '模型半截文件', toSlash(path.relative(dataDir, abs)));
      }
    }
  }
}

// 备份上限：每个文档保留最近 20 份；每个库总量超过 500MB 时从最旧的删起，直到不超过
async function capBackups(sw, dataDir) {
  const kroot = path.join(dataDir, 'knowledge');
  let dsIds = [];
  try {
    dsIds = (await fs.promises.readdir(kroot, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return;
  }
  for (const dsId of dsIds) {
    const root = path.join(kroot, dsId, 'backups');
    const list = []; // { abs, label, doc, stamp, size }
    const stack = [''];
    while (stack.length) {
      const rel = stack.pop();
      let ents;
      try {
        ents = await fs.promises.readdir(path.join(root, rel), { withFileTypes: true });
      } catch {
        continue;
      }
      for (const ent of ents) {
        await sw.tick();
        const childRel = rel ? rel + '/' + ent.name : ent.name;
        if (ent.isDirectory()) {
          stack.push(childRel);
          continue;
        }
        const m = ent.isFile() ? BACKUP_NAME.exec(ent.name) : null;
        if (!m) continue;
        const abs = path.join(root, childRel);
        try {
          const st = await fs.promises.lstat(abs);
          list.push({ abs, label: `knowledge/${dsId}/backups/${childRel}`, doc: (rel ? rel + '/' : '') + m[1], stamp: m[2], size: st.size });
        } catch { /* 已不在 */ }
      }
    }
    const byDoc = new Map();
    for (const b of list) {
      if (!byDoc.has(b.doc)) byDoc.set(b.doc, []);
      byDoc.get(b.doc).push(b);
    }
    const kept = [];
    for (const group of byDoc.values()) {
      group.sort((a, b) => (a.stamp < b.stamp ? 1 : a.stamp > b.stamp ? -1 : 0));
      kept.push(...group.slice(0, BACKUPS_PER_DOC));
      for (const b of group.slice(BACKUPS_PER_DOC)) {
        await sw.tick();
        await remove(sw, b.abs, '备份（每个文档超过 20 份）', b.label);
      }
    }
    let total = kept.reduce((n, b) => n + b.size, 0);
    if (total <= BACKUPS_MAX_BYTES) continue;
    kept.sort((a, b) => (a.stamp < b.stamp ? -1 : a.stamp > b.stamp ? 1 : 0));
    for (const b of kept) {
      if (total <= BACKUPS_MAX_BYTES) break;
      await sw.tick();
      if (await remove(sw, b.abs, '备份（库总量超过 500MB）', b.label)) total -= b.size;
    }
  }
}

// 停在 .trash 中转里的删除批次（本次启动前就在）：重新交给系统回收站，成功后删掉中转目录，失败保留。
// 没有系统回收站（独立运行或 WORKBENCH_TRASH=local）时 .trash 就是回收站本身，不动。
async function resubmitTrash(sw, libraries, bootAt) {
  const handler = getTrashHandler();
  if (!handler) return;
  for (const lib of libraries) {
    const root = path.join(lib.baseDir, TRASH_DIR);
    let ents;
    try {
      ents = await fs.promises.readdir(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of ents) {
      await sw.tick();
      if (!ent.isDirectory() || !TRASH_BATCH.test(ent.name)) continue;
      const abs = path.join(root, ent.name);
      const label = `${lib.name}/${TRASH_DIR}/${ent.name}`;
      try {
        if ((await fs.promises.lstat(abs)).mtimeMs >= bootAt) continue;
      } catch {
        continue;
      }
      try {
        await handler(abs);
      } catch (e) {
        console.warn(`[sweep] ${label} 交给系统回收站失败，保留在 ${TRASH_DIR}/：${e.message}`);
        continue;
      }
      await remove(sw, abs, '回收站中转交给系统回收站', label);
    }
  }
}

// 不再被引用的 pi 会话文件：不被任何对话引用、不是显示记录、修改时间超过 1 天；对话索引不可用时整项跳过
async function sweepSessionFiles(sw, agentHub, dataDir) {
  if (!agentHub) return;
  const refs = await agentHub.sessionFileRefs();
  if (!refs) {
    sw.skipped.push('会话文件（对话索引缺失、损坏、刚重建或读不到）');
    return;
  }
  for (const dir of refs.dirs) {
    let ents;
    try {
      ents = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of ents) {
      await sw.tick();
      if (!ent.isFile() || !PI_SESSION_FILE.test(ent.name) || refs.keep.has(ent.name)) continue;
      const abs = path.join(dir, ent.name);
      if (await olderThan(abs, DAY)) await remove(sw, abs, '会话文件', toSlash(path.relative(dataDir, abs)));
    }
  }
}

function summaryLine(sw, ms) {
  const parts = [...sw.counts].map(([k, n]) => `${k} ${n}`);
  let line = `[sweep] 启动清理完成，耗时 ${ms}ms：` + (parts.length ? parts.join('，') : '没有需要清理的条目');
  if (sw.items.length) {
    const shown = sw.items.slice(0, SUMMARY_LIST_MAX).join('、');
    line += '；涉及：' + shown + (sw.items.length > SUMMARY_LIST_MAX ? ` 等 ${sw.items.length} 项` : '');
  }
  if (sw.skipped.length) line += '；跳过：' + sw.skipped.join('、');
  return line;
}

/**
 * 执行一次启动清理。libraries: [{ id, name, baseDir }]（已打开的库）；embed: EmbedService；
 * agentHub: AgentHub；bootAt: 后端进程启动时间（之后放进 .trash 的批次归删除流程自己处理）。
 */
export async function runStartupSweep({ dataDir, libraries = [], embed = null, agentHub = null, bootAt = Date.now() }) {
  const t0 = Date.now();
  const sw = createSweep();
  await withActivity('启动清理', async () => {
    const steps = [
      ['数据目录', () => sweepDataDir(sw, dataDir)],
      ...libraries.map((lib) => [`资料库 ${lib.name}`, () => sweepLibrary(sw, lib)]),
      ['模型半截文件', () => sweepForeignParts(sw, embed, dataDir)],
      ['备份上限', () => capBackups(sw, dataDir)],
      ['incidents 上限', async () => {
        const r = await capIncidents(dataDir);
        if (r) sw.note('incidents.jsonl 收缩', `logs/incidents.jsonl（${r.before} → ${r.after} 条）`);
      }],
      ['回收站中转', () => resubmitTrash(sw, libraries, bootAt)],
      ['会话文件', () => sweepSessionFiles(sw, agentHub, dataDir)],
    ];
    for (const [name, run] of steps) {
      try {
        await run();
      } catch (e) {
        console.warn(`[sweep] ${name}清理出错，已跳过：${e.message}`);
      }
    }
  });
  console.log(summaryLine(sw, Date.now() - t0));
  return { counts: Object.fromEntries(sw.counts), items: sw.items, skipped: sw.skipped };
}

/** 后端就绪后延迟执行一次启动清理（不阻塞启动与扫描）；libraries 为取当前已打开库的函数 */
export function scheduleStartupSweep({ libraries, ...rest }) {
  const timer = setTimeout(() => {
    runStartupSweep({ ...rest, libraries: libraries() }).catch((e) => console.warn('[sweep] 启动清理失败：' + e.message));
  }, DELAY_MS);
  timer.unref?.();
}
