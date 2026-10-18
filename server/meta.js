// 元数据导入：JSONL 逐行按 JSON Schema 校验，生成写入计划并落盘。
// 只写 <文件名>.meta.json 旁注，绝不修改文档本身；schema 从 ../schema/ 读取（相对本模块，
// 打包进 Electron asar 后路径依然成立）。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { SIDECAR_SUFFIX, isSidecar } from './scanner.js';

// 文档内容的字节摘要（sha256:<hex>），本模块是唯一出处
export function contentHash(buf) {
  return 'sha256:' + crypto.createHash('sha256').update(buf).digest('hex');
}

const SCHEMA_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'schema');

function loadSchema(name) {
  return JSON.parse(fs.readFileSync(path.join(SCHEMA_DIR, name), 'utf8'));
}

const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);
const metaSchema = loadSchema('meta.schema.json');
const importSchema = loadSchema('meta-import.schema.json');
ajv.addSchema(metaSchema); // 供 meta-import.schema.json 以 $ref 相对引用
const metaCompiled = ajv.compile(metaSchema);
const importCompiled = ajv.compile(importSchema);

// Ajv 错误 → 人类可读中文（形如 “/date 格式不正确”）
function describeError(e) {
  const p = e.params || {};
  switch (e.keyword) {
    case 'required': return '缺少必填字段 ' + p.missingProperty;
    case 'additionalProperties': return '不允许的字段 ' + p.additionalProperty;
    case 'propertyNames': return '包含不允许的字段名 ' + p.propertyName;
    case 'enum': return '取值必须是 ' + (p.allowedValues || []).map((v) => JSON.stringify(v)).join(' / ');
    case 'pattern': case 'format': case 'anyOf': case 'const': return '格式不正确';
    case 'minLength': return '不能为空';
    case 'type': return '类型不正确';
    case 'uniqueItems': return '包含重复项';
    case 'minimum': return '数值必须不小于 ' + p.limit;
    case 'maximum': return '数值必须不大于 ' + p.limit;
    default: return e.message || '不合法';
  }
}

function humanErrors(compiled) {
  const msgs = (compiled.errors || []).map((e) => (e.instancePath + ' ' + describeError(e)).trim());
  return [...new Set(msgs)]; // anyOf + 分支错误会重复，去重
}

export function validateMeta(obj) {
  const ok = metaCompiled(obj);
  return { ok, errors: ok ? [] : humanErrors(metaCompiled) };
}

export function validateImportLine(obj) {
  const ok = importCompiled(obj);
  return { ok, errors: ok ? [] : humanErrors(importCompiled) };
}

// ---------- 导入计划 ----------

const EDITABLE_FIELDS = ['title', 'type', 'date', 'source_url', 'aliases', 'tags'];
const META_KEY_ORDER = ['id', 'title', 'type', 'date', 'source_url', 'aliases', 'tags', 'content_hash', 'created_at'];
const DOC_EXTS = ['.md', '.txt', '.docx', '.doc'];

function deepEqual(a, b) {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => deepEqual(x, b[i]));
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const ka = Object.keys(a), kb = Object.keys(b);
    return ka.length === kb.length && ka.every((k) => deepEqual(a[k], b[k]));
  }
  return false;
}

// 按 meta.schema.json 的固定键序重排（未知键保持在末尾，交给 schema 校验拦截）
function reorderMeta(obj) {
  const out = {};
  for (const k of META_KEY_ORDER) if (k in obj) out[k] = obj[k];
  for (const k of Object.keys(obj)) if (!(k in out)) out[k] = obj[k];
  return out;
}

// 解析并规划一次 JSONL 导入：不写任何文件。
// resolveDocPath(rel) 由调用方注入（validateRelDir + resolveWithin），越界/非法时抛错。
export function planImport({ baseDir, text, overwrite, resolveDocPath }) {
  const lines = String(text ?? '').split(/\r?\n/);
  const items = [];
  const errors = [];
  const ops = []; // 待写入操作（仅 create/update）
  const seen = new Set();
  const summary = { lines: 0, valid: 0, errors: 0, create: 0, update: 0, skip: 0 };

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (!raw.trim()) continue; // 空白行跳过（仍占行号）
    const line = i + 1;
    summary.lines++;
    const fail = (error, p) => errors.push(p === undefined ? { line, error } : { line, path: p, error });

    let obj;
    try {
      obj = JSON.parse(raw);
    } catch (e) {
      fail('不是合法 JSON: ' + e.message);
      continue;
    }
    const v = validateImportLine(obj);
    if (!v.ok) { fail(v.errors.join('；')); continue; }

    const p = obj.path;
    let abs;
    try {
      abs = resolveDocPath(p);
    } catch {
      fail('path 越界', p);
      continue;
    }
    if (seen.has(p)) { fail('path 重复', p); continue; }
    seen.add(p);
    const parts = p.split('/');
    if (parts.some((s) => s.startsWith('.'))) { fail('path 位于隐藏目录或回收站', p); continue; }
    if (isSidecar(parts[parts.length - 1])) { fail('path 不能是元数据文件本身', p); continue; }
    const ext = path.posix.extname(p).toLowerCase();
    if (!DOC_EXTS.includes(ext)) { fail('path 不是受支持的文档（.md/.txt/.docx/.doc）', p); continue; }
    let st;
    try { st = fs.statSync(abs); } catch { fail('文件不存在', p); continue; }
    if (!st.isFile()) { fail('不是常规文件', p); continue; }

    const provided = {};
    for (const k of EDITABLE_FIELDS) if (k in obj) provided[k] = obj[k];
    const extra = {};
    if (obj.confidence !== undefined) extra.confidence = obj.confidence;
    if (obj.notes !== undefined) extra.notes = obj.notes;
    const sidecarAbs = abs + SIDECAR_SUFFIX;
    let hasSidecar = false;
    try { fs.lstatSync(sidecarAbs); hasSidecar = true; } catch { /* 尚无旁注 */ }

    if (!hasSidecar) {
      // 新建：默认值上覆盖提供的字段；标题缺省取文件名主体
      const name = parts[parts.length - 1];
      const stem = name.slice(0, name.length - ext.length);
      const meta = {
        id: 'doc_' + crypto.randomUUID(),
        title: provided.title ?? stem,
        type: provided.type ?? '',
        date: provided.date ?? '',
        source_url: provided.source_url ?? '',
        aliases: provided.aliases ?? [],
        tags: provided.tags ?? [],
        content_hash: contentHash(fs.readFileSync(abs)),
        created_at: new Date().toISOString(),
      };
      const mv = validateMeta(meta);
      if (!mv.ok) { fail(mv.errors.join('；'), p); continue; }
      const fields = {};
      for (const k of EDITABLE_FIELDS) fields[k] = meta[k];
      items.push({ line, path: p, action: 'create', fields, ...extra });
      ops.push({ line, path: p, kind: 'create', sidecarAbs, content: JSON.stringify(meta, null, 2) + '\n' });
      summary.create++;
    } else if (!overwrite) {
      items.push({ line, path: p, action: 'skip', reason: '已有元数据，未覆盖', ...extra });
      summary.skip++;
    } else {
      // 覆盖更新：只合并提供的字段；id 与 created_at 永不改变；content_hash 按当前文档字节重算
      let existing;
      try {
        existing = JSON.parse(fs.readFileSync(sidecarAbs, 'utf8'));
      } catch (e) {
        fail('已有元数据不是合法 JSON，未修改' + (e instanceof SyntaxError ? ': ' + e.message : ''), p);
        continue;
      }
      if (!existing || typeof existing !== 'object' || Array.isArray(existing)) {
        fail('已有元数据不是 JSON 对象，未修改', p);
        continue;
      }
      const merged = reorderMeta({ ...existing, ...provided });
      merged.content_hash = contentHash(fs.readFileSync(abs));
      const mv = validateMeta(merged);
      if (!mv.ok) { fail(mv.errors.join('；'), p); continue; }
      const changed = {};
      for (const k of Object.keys(merged)) {
        if (!deepEqual(merged[k], existing[k])) changed[k] = { from: existing[k] ?? null, to: merged[k] };
      }
      if (Object.keys(changed).length === 0) {
        items.push({ line, path: p, action: 'skip', reason: '无变化', ...extra });
        summary.skip++;
      } else {
        items.push({ line, path: p, action: 'update', fields: changed, ...extra });
        ops.push({ line, path: p, kind: 'update', sidecarAbs, content: JSON.stringify(merged, null, 2) + '\n' });
        summary.update++;
      }
    }
  }
  summary.valid = summary.create + summary.update + summary.skip;
  summary.errors = errors.length;
  return { summary, items, errors, ops };
}

// ---------- 写入 ----------

// 原子且不覆盖地写入旁注：临时文件 + 硬链接（目标已存在则 EEXIST → 跳过）；
// 硬链接不可用的文件系统（EPERM/ENOTSUP/EXDEV）退化为「存在即跳过 + 改名」
function writeSidecarNoOverwrite(sidecar, content) {
  const tmp = sidecar + '.wb-tmp-' + process.pid;
  try {
    fs.writeFileSync(tmp, content, 'utf8');
    try {
      fs.linkSync(tmp, sidecar);
    } finally {
      fs.unlinkSync(tmp);
    }
    return true;
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    if (e.code === 'EEXIST') return false;
    if (['EPERM', 'ENOTSUP', 'EXDEV'].includes(e.code)) {
      if (fs.existsSync(sidecar)) return false;
      fs.writeFileSync(tmp, content, 'utf8');
      fs.renameSync(tmp, sidecar); // rename 不会覆盖（上面已确认不存在）
      return true;
    }
    throw e;
  }
}

function writeTextAtomic(abs, content) {
  const tmp = abs + '.wb-tmp-' + process.pid;
  fs.writeFileSync(tmp, content, 'utf8');
  fs.renameSync(tmp, abs);
}

// 应用导入：与预览同参重新计算计划（无状态），逐行写入；单行失败只计入 errors，不影响其余行。
// 返回值与 planImport 相同（items/summary/errors），另加 summary.written。
export function applyImport(args) {
  const plan = planImport(args);
  let written = 0;
  const byLine = new Map(plan.items.map((it) => [it.line, it]));
  for (const op of plan.ops) {
    try {
      if (op.kind === 'create') {
        if (writeSidecarNoOverwrite(op.sidecarAbs, op.content)) {
          written++;
        } else {
          // 规划后到写入前出现了旁注（竞态）：转记为跳过
          const it = byLine.get(op.line);
          if (it) { it.action = 'skip'; it.reason = '已有元数据，未覆盖'; }
          plan.summary.create--;
          plan.summary.skip++;
        }
      } else {
        writeTextAtomic(op.sidecarAbs, op.content);
        written++;
      }
    } catch (e) {
      plan.errors.push({ line: op.line, path: op.path, error: '写入失败: ' + e.message });
    }
  }
  plan.summary.errors = plan.errors.length;
  plan.summary.written = written;
  return plan;
}
