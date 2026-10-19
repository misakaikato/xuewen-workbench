// 三层记忆存储：全局（memory/）· Agent（agents/<id>/memory/）· 库（knowledge/<dsId>/memory/）
// 每层两个文件：facts.jsonl（结构化条目，append-only）+ summary.md（压缩摘要，可重写）
// 容量策略：facts > 200 条触发 consolidate（保留最近 150 条 + 全部 pinned）；
//          pinned 每层上限 20 条，永不淘汰（库层的 pinned 额外全量注入 system prompt）
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const FACTS_LIMIT = 200; // 超过触发 consolidate
export const KEEP_AFTER_CONSOLIDATE = 150; // consolidate 后保留的最新条数
export const PINNED_LIMIT = 20; // 每层 pinned 上限
export const SUMMARY_MAX_CHARS = 2000; // summary 上限（超过需二次压缩）

const newFactId = () => 'f_' + crypto.randomBytes(3).toString('hex');

/** 记忆作用域路径解析：scope + 上下文 → 目录 */
export function memoryDir(dataDir, scope, { agentId = 'default', dsId = null } = {}) {
  if (scope === 'global') return path.join(dataDir, 'memory');
  if (scope === 'agent') return path.join(dataDir, 'agents', agentId, 'memory');
  if (scope === 'library') {
    if (!dsId) throw new Error('库记忆需要 dsId');
    return path.join(dataDir, 'knowledge', dsId, 'memory');
  }
  throw new Error('未知的记忆作用域: ' + scope);
}

export class MemoryStore {
  constructor(dataDir) {
    this.dataDir = dataDir;
  }

  _paths(scope, ctx) {
    const dir = memoryDir(this.dataDir, scope, ctx);
    return { dir, facts: path.join(dir, 'facts.jsonl'), summary: path.join(dir, 'summary.md') };
  }

  /** 读全部 facts（坏行跳过） */
  loadFacts(scope, ctx = {}) {
    const { facts } = this._paths(scope, ctx);
    try {
      const lines = fs.readFileSync(facts, 'utf8').split('\n');
      const out = [];
      for (const ln of lines) {
        if (!ln.trim()) continue;
        try {
          const o = JSON.parse(ln);
          if (o && o.fact) out.push(o);
        } catch { /* 坏行跳过 */ }
      }
      return out;
    } catch {
      return [];
    }
  }

  _writeFacts(scope, ctx, list) {
    const { dir, facts } = this._paths(scope, ctx);
    fs.mkdirSync(dir, { recursive: true });
    // 原子写：临时文件 + rename
    const tmp = facts + '.tmp-' + process.pid;
    fs.writeFileSync(tmp, list.map((f) => JSON.stringify(f)).join('\n') + (list.length ? '\n' : ''));
    fs.renameSync(tmp, facts);
  }

  /** 新增一条记忆；pinned 超限时抛错（调用方转成工具错误） */
  addFact(scope, ctx, { fact, kind = 'knowledge', pinned = false, source = null }) {
    const text = String(fact || '').trim();
    if (!text) throw new Error('记忆内容不能为空');
    const list = this.loadFacts(scope, ctx);
    // 去重：完全相同的内容不重复写
    const dup = list.find((f) => f.fact.trim() === text);
    if (dup) {
      if (pinned && !dup.pinned) return this.setPinned(scope, ctx, dup.id, true);
      return { ...dup, duplicate: true };
    }
    if (pinned) {
      const pinnedCount = list.filter((f) => f.pinned).length;
      if (pinnedCount >= PINNED_LIMIT) {
        throw new Error(`本层固定记忆已达上限 ${PINNED_LIMIT} 条，请先取消部分固定记忆`);
      }
    }
    const item = {
      id: newFactId(),
      fact: text,
      kind: ['preference', 'knowledge', 'convention'].includes(kind) ? kind : 'knowledge',
      pinned: !!pinned,
      source: source || null,
      at: new Date().toISOString(),
    };
    list.push(item);
    this._writeFacts(scope, ctx, list);
    return item;
  }

  /** 删除：按 id 精确删，或按 query 模糊匹配删（返回删除的条目） */
  removeFact(scope, ctx, { id, query } = {}) {
    const list = this.loadFacts(scope, ctx);
    let removed = [];
    let kept;
    if (id) {
      kept = list.filter((f) => {
        if (f.id === id) { removed.push(f); return false; }
        return true;
      });
    } else if (query) {
      const q = String(query).toLowerCase();
      kept = list.filter((f) => {
        if (f.fact.toLowerCase().includes(q)) { removed.push(f); return false; }
        return true;
      });
    } else {
      throw new Error('需要 id 或 query');
    }
    if (removed.length) this._writeFacts(scope, ctx, kept);
    return removed;
  }

  /** 更新一条记忆（文本和/或 pinned），一次读写完成 */
  updateFact(scope, ctx, id, { fact, pinned } = {}) {
    const list = this.loadFacts(scope, ctx);
    const target = list.find((f) => f.id === id);
    if (!target) throw new Error('记忆不存在: ' + id);
    if (typeof fact === 'string' && fact.trim()) target.fact = fact.trim();
    if (typeof pinned === 'boolean') {
      if (pinned && !target.pinned) {
        const count = list.filter((f) => f.pinned).length;
        if (count >= PINNED_LIMIT) throw new Error(`本层固定记忆已达上限 ${PINNED_LIMIT} 条`);
      }
      target.pinned = pinned;
    }
    this._writeFacts(scope, ctx, list);
    return target;
  }

  /** 更新一条记忆的文本（保留其余字段） */
  updateFactText(scope, ctx, id, fact) {
    const text = String(fact || '').trim();
    if (!text) throw new Error('记忆内容不能为空');
    const list = this.loadFacts(scope, ctx);
    const target = list.find((f) => f.id === id);
    if (!target) throw new Error('记忆不存在: ' + id);
    target.fact = text;
    this._writeFacts(scope, ctx, list);
    return target;
  }

  setPinned(scope, ctx, id, pinned) {
    const list = this.loadFacts(scope, ctx);
    const target = list.find((f) => f.id === id);
    if (!target) throw new Error('记忆不存在: ' + id);
    if (pinned && !target.pinned) {
      const count = list.filter((f) => f.pinned).length;
      if (count >= PINNED_LIMIT) throw new Error(`本层固定记忆已达上限 ${PINNED_LIMIT} 条`);
    }
    target.pinned = !!pinned;
    this._writeFacts(scope, ctx, list);
    return target;
  }

  loadSummary(scope, ctx = {}) {
    try {
      return fs.readFileSync(this._paths(scope, ctx).summary, 'utf8');
    } catch {
      return '';
    }
  }

  saveSummary(scope, ctx, text) {
    const { dir, summary } = this._paths(scope, ctx);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = summary + '.tmp-' + process.pid;
    fs.writeFileSync(tmp, String(text || ''));
    fs.renameSync(tmp, summary);
  }

  /** 是否需要 consolidate（facts 超限） */
  needsConsolidate(scope, ctx) {
    return this.loadFacts(scope, ctx).length > FACTS_LIMIT;
  }

  /**
   * consolidate 后的裁剪：保留「全部 pinned + 最近 KEEP_AFTER_CONSOLIDATE 条非 pinned」
   * 返回被淘汰的条目（供上层喂给 LLM 压缩进 summary）
   */
  planPrune(scope, ctx) {
    const list = this.loadFacts(scope, ctx);
    const pinned = list.filter((f) => f.pinned);
    const unpinned = list.filter((f) => !f.pinned);
    const keepUnpinned = unpinned.slice(-KEEP_AFTER_CONSOLIDATE);
    const dropped = unpinned.slice(0, Math.max(0, unpinned.length - KEEP_AFTER_CONSOLIDATE));
    return {
      dropped,
      kept: [...pinned, ...keepUnpinned],
      pinnedCount: pinned.length,
    };
  }

  /** 应用裁剪（在 summary 写好之后调用） */
  applyPrune(scope, ctx, kept) {
    this._writeFacts(scope, ctx, kept);
  }

  /**
   * 记忆检索（recall）：关键词匹配 + 简单打分
   * 打分：命中词数 × 2 + 标题/开头命中加权 + pinned 加权 + 新近度微调
   */
  recall(scope, ctx, query, limit = 8) {
    const scopes = scope === 'all' ? ['global', 'agent', 'library'] : [scope];
    const tokens = tokenize(query);
    const hits = [];
    const wantRecent = tokens.length === 0; // 空查询 = 「我记过什么」→ 返回最近记忆
    for (const sc of scopes) {
      const list = this.loadFacts(sc, ctx);
      if (wantRecent) {
        for (const f of list) {
          hits.push({ scope: sc, ...f, score: f.pinned ? 2 : 1 });
        }
        continue;
      }
      for (const f of list) {
        const text = f.fact.toLowerCase();
        let score = 0;
        for (const t of tokens) {
          if (text.includes(t)) score += 2;
        }
        if (!score) continue;
        if (f.pinned) score += 1; // 固定记忆略优先
        // 新近度：30 天内 +1，否则 0
        const ageDays = (Date.now() - Date.parse(f.at || 0)) / 86400000;
        if (ageDays < 30) score += 1;
        hits.push({ scope: sc, ...f, score });
      }
    }
    hits.sort((a, b) => (wantRecent ? 0 : b.score - a.score) || (b.at || '').localeCompare(a.at || ''));
    return hits.slice(0, Math.max(1, Math.min(50, limit)));
  }

  /** 各层统计（UI 用） */
  stats(ctx = {}) {
    const out = {};
    for (const sc of ['global', 'agent', 'library']) {
      try {
        const list = this.loadFacts(sc, ctx);
        out[sc] = {
          facts: list.length,
          pinned: list.filter((f) => f.pinned).length,
          hasSummary: !!this.loadSummary(sc, ctx),
          summaryChars: this.loadSummary(sc, ctx).length,
        };
      } catch {
        out[sc] = { facts: 0, pinned: 0, hasSummary: false, summaryChars: 0, error: '不可用' };
      }
    }
    return out;
  }
}

/** 中文按字 bigram + 英文数字按词，返回小写 token 列表 */
export function tokenize(text) {
  const s = String(text || '').toLowerCase();
  const out = new Set();
  // 英文/数字词
  for (const m of s.matchAll(/[a-z0-9_]{2,}/g)) out.add(m[0]);
  // 中文 bigram（相邻两字）
  const cjk = [...s.replace(/[^\u4e00-\u9fff]/g, ' ')];
  let run = '';
  for (const ch of s) {
    if (/[\u4e00-\u9fff]/.test(ch)) run += ch;
    else {
      for (let i = 0; i + 2 <= run.length; i++) out.add(run.slice(i, i + 2));
      run = '';
    }
  }
  for (let i = 0; i + 2 <= run.length; i++) out.add(run.slice(i, i + 2));
  void cjk;
  return [...out];
}

/** 拼装注入 system prompt 的记忆段落（供 manager 调用） */
export function buildMemorySection(store, ctx) {
  const parts = [];

  // 全局层：summary + 全部 facts
  const gFacts = store.loadFacts('global', ctx);
  const gSummary = store.loadSummary('global', ctx).trim();
  if (gSummary || gFacts.length) {
    const lines = ['## 全局记忆（用户偏好，跨库有效）'];
    if (gSummary) lines.push(gSummary);
    if (gFacts.length) lines.push(gFacts.map((f) => '- ' + f.fact).join('\n'));
    parts.push(lines.join('\n'));
  }

  // Agent 层：summary + 全部 facts
  const aFacts = store.loadFacts('agent', ctx);
  const aSummary = store.loadSummary('agent', ctx).trim();
  if (aSummary || aFacts.length) {
    const lines = ['## Agent 记忆（你的习性，跨库有效）'];
    if (aSummary) lines.push(aSummary);
    if (aFacts.length) lines.push(aFacts.map((f) => '- ' + f.fact).join('\n'));
    parts.push(lines.join('\n'));
  }

  // 库层：summary + pinned（其余需 recall）
  if (ctx.dsId) {
    const lFacts = store.loadFacts('library', ctx);
    const lSummary = store.loadSummary('library', ctx).trim();
    const pinned = lFacts.filter((f) => f.pinned);
    const restCount = lFacts.length - pinned.length;
    if (lSummary || pinned.length || restCount > 0) {
      const lines = ['## 本库记忆（优先于全局记忆）'];
      if (lSummary) lines.push(lSummary);
      if (pinned.length) lines.push(pinned.map((f) => '- ' + f.fact).join('\n'));
      if (restCount > 0) lines.push(`（另有 ${restCount} 条库记忆未列出，需要时用 recall 检索）`);
      parts.push(lines.join('\n'));
    }
  }

  return parts.join('\n\n');
}
