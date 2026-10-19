// 软件设置工具：让 agent 能读写 Workbench 的各项设置
// 覆盖：外观主题 / 阅读偏好 / RAG 检索参数 / Agent 设置 / 逻辑集合 / 资料库
// 阅读偏好存前端 localStorage，经 SSE 推事件由前端执行
import fs from 'node:fs';
import path from 'node:path';
import { getUiSettings, saveUiSettings, getState, setState } from '../store.js';

export const SETTABLE = {
  theme: {
    desc: '外观主题：A=宣纸书卷 / B=现代极简 / C=夜读',
    fields: { theme: "'A' | 'B' | 'C'" },
  },
  reading: {
    desc: '阅读偏好：字体 font(serif|sans|mono)、字号 fontSize(14-32)、行距 lineHeight(1.4-2.4)、段距 paraSpacing(0-2em)、页宽 width(560-1080)、代码字号 codeFontSize(12-20)',
    fields: { font: 'string', fontSize: 'number', lineHeight: 'number', paraSpacing: 'number', width: 'number', codeFontSize: 'number' },
  },
  rag: {
    desc: 'RAG 检索参数：chunk.maxChars / chunk.jsonValueLimit / chunk.headingContext / embed.maxLength / search.topN / search.rrfK / search.rrfMin / search.cosFloor / search.cosSigma / search.semanticWeight',
    fields: { chunk: 'object', embed: 'object', search: 'object' },
  },
  agent: {
    desc: 'Agent 设置：model（模型名）、thinkingLevel(off|low|medium|high)、mode(auto|confirm|readonly)',
    fields: { model: 'string', thinkingLevel: 'string', mode: 'string' },
  },
  collections: {
    desc: '逻辑集合：action=add/update/remove，name，dirs（目录数组）',
    fields: { action: 'add|update|remove', name: 'string', dirs: 'string[]' },
  },
  library: {
    desc: '资料库：action=add/activate/remove，baseDir（绝对路径）。remove 仅移出工作区，不删磁盘文件',
    fields: { action: 'add|activate|remove', baseDir: 'string', dsId: 'string' },
  },
};

/** 读取当前设置快照 */
export function readSettings(ctx) {
  const { hub, lib, ragManager } = ctx;
  const ui = getUiSettings();
  const out = {
    theme: { theme: ui.theme, autoUpdate: ui.autoUpdate, notesDir: ui.notesDir },
    reading: null, // 前端 localStorage，服务端不持有；由 agent 告知用户当前值需前端回报
    rag: hub.ragManager.index(lib?.id || '').cfg ?? null,
    agent: {
      model: ragManager.llm.model || '',
      baseUrl: ragManager.llm.baseUrl || '',
      thinkingLevel: ragManager.llm.thinkingLevel || 'off',
      mode: hub.mode,
    },
    collections: lib ? getState(lib.id, 'collections', []) : [],
    library: { current: lib ? { id: lib.id, name: lib.name, baseDir: lib.baseDir } : null },
  };
  return out;
}

/** 写设置；返回 { ok, applied, note } */
export function applySettings(ctx, category, patch) {
  const { hub, lib, ragManager, emit } = ctx;
  if (!SETTABLE[category]) throw new Error('未知的设置类别: ' + category);
  if (!patch || typeof patch !== 'object') throw new Error('patch 必须是对象');

  switch (category) {
    case 'theme': {
      const theme = String(patch.theme || '');
      if (!['A', 'B', 'C'].includes(theme)) throw new Error("theme 只能是 'A' / 'B' / 'C'");
      saveUiSettings({ theme });
      emit?.({ t: 'settings_changed', category: 'theme', value: theme }); // 前端刷新外观
      return { ok: true, applied: { theme } };
    }

    case 'reading': {
      // 前端 localStorage 持有：推事件让前端更新并持久化
      const allowed = ['font', 'fontSize', 'lineHeight', 'paraSpacing', 'width', 'codeFontSize'];
      const next = {};
      for (const k of allowed) if (k in patch) next[k] = patch[k];
      if (!Object.keys(next).length) throw new Error('没有可用的阅读偏好字段：' + allowed.join(', '));
      if ('font' in next && !['serif', 'sans', 'mono'].includes(next.font)) throw new Error("font 只能是 serif/sans/mono");
      for (const [k, [lo, hi]] of Object.entries({ fontSize: [14, 32], lineHeight: [1.4, 2.4], paraSpacing: [0, 2], width: [560, 1080], codeFontSize: [12, 20] })) {
        if (k in next) {
          const v = Number(next[k]);
          if (!Number.isFinite(v)) throw new Error(`${k} 必须是数字`);
          next[k] = Math.min(hi, Math.max(lo, v));
        }
      }
      emit?.({ t: 'settings_changed', category: 'reading', value: next });
      return { ok: true, applied: next, note: '已应用到当前界面（阅读偏好存于本机浏览器）' };
    }

    case 'rag': {
      if (!lib) throw new Error('当前没有打开的资料库');
      const next = hub.ragManager.saveConfig(lib.id, patch);
      hub.ragManager.index(lib.id).cfg = next; // 立即生效
      return { ok: true, applied: { chunk: next.chunk, embed: next.embed, search: next.search }, note: '切块/嵌入参数变更需重建索引才能完全生效' };
    }

    case 'agent': {
      const p = {};
      for (const k of ['model', 'thinkingLevel', 'mode', 'baseUrl', 'apiKey']) if (k in patch) p[k] = patch[k];
      if (!Object.keys(p).length) throw new Error('没有可用的 Agent 设置字段');
      hub.updateSettings(p);
      // 若只是思考强度，已作用于活跃会话；模型变更会重建会话
      return { ok: true, applied: p, note: 'model 变更会导致现有对话上下文重建' };
    }

    case 'collections': {
      if (!lib) throw new Error('当前没有打开的资料库');
      const action = String(patch.action || '');
      const name = String(patch.name || '').trim();
      const cur = getState(lib.id, 'collections', []);
      if (action === 'add' || action === 'update') {
        if (!name) throw new Error('缺少集合名 name');
        const dirs = Array.isArray(patch.dirs) ? patch.dirs.map(String) : [];
        const idx = cur.findIndex((c) => c.name === name);
        if (action === 'add' && idx >= 0) throw new Error('同名集合已存在: ' + name);
        if (action === 'update' && idx < 0) throw new Error('集合不存在: ' + name);
        const next = [...cur];
        if (idx >= 0) next[idx] = { name, dirs };
        else next.push({ name, dirs });
        setState(lib.id, 'collections', next);
        return { ok: true, applied: { action, name, dirs } };
      }
      if (action === 'remove') {
        if (!name) throw new Error('缺少集合名 name');
        const next = cur.filter((c) => c.name !== name);
        if (next.length === cur.length) throw new Error('集合不存在: ' + name);
        setState(lib.id, 'collections', next);
        return { ok: true, applied: { action, name } };
      }
      throw new Error("action 只能是 add / update / remove");
    }

    case 'library': {
      const action = String(patch.action || '');
      if (action === 'remove') {
        if (!patch.dsId && !patch.baseDir) throw new Error('remove 需要 dsId 或 baseDir');
        // 真正移除走 hub 外部回调（server/index.js 提供），避免这里持有 libs Map
        const r = ctx.removeLibrary?.(patch.dsId || null, patch.baseDir || null);
        if (!r?.ok) throw new Error(r?.error || '移除失败');
        return { ok: true, applied: { action, ...r } };
      }
      if (action === 'add' || action === 'activate') {
        if (!patch.baseDir) throw new Error('需要 baseDir 绝对路径');
        const r = ctx.addOrActivateLibrary?.(String(patch.baseDir));
        if (!r?.ok) throw new Error(r?.error || '操作失败');
        return { ok: true, applied: { action, ...r } };
      }
      throw new Error("action 只能是 add / activate / remove");
    }

    default:
      throw new Error('未实现: ' + category);
  }
}

/** 把扁平的参数按 category 组装成各自需要的 patch 结构 */
// 类别别名容错（小模型常写 mode / theme-setting / collection 等变体）
export const CATEGORY_ALIAS = {
  theme: 'theme', appearance: 'theme', 外观: 'theme', 主题: 'theme',
  reading: 'reading', read: 'reading', 阅读: 'reading', 阅读偏好: 'reading',
  rag: 'rag', retrieval: 'rag', search: 'rag', 检索: 'rag',
  agent: 'agent', mode: 'agent', model: 'agent', 模式: 'agent', 模型: 'agent',
  collections: 'collections', collection: 'collections', 集合: 'collections',
  library: 'library', libraries: 'library', 资料库: 'library', 库: 'library',
};

export function normalizeCategory(raw) {
  const k = String(raw || '').trim().toLowerCase();
  return CATEGORY_ALIAS[k] || k;
}

export function buildPatch(category, p) {
  const pick = (keys) => {
    const out = {};
    for (const k of keys) if (p[k] !== undefined) out[k] = p[k];
    return out;
  };
  // 容错：小模型常把单值参数写成 value / val / target，按类别映射到对应字段
  const one = p.value ?? p.val ?? p.target;
  switch (category) {
    case 'theme':
      return { theme: p.theme ?? one };
    case 'reading':
      return pick(['font', 'fontSize', 'lineHeight', 'paraSpacing', 'width', 'codeFontSize']);
    case 'rag': {
      const chunk = pick(['chunkMaxChars', 'jsonValueLimit', 'headingContext', 'hardSplitOversize', 'fileNameContext']);
      const embed = pick(['maxLength']);
      const search = pick(['topN', 'rrfK', 'rrfMin', 'cosFloor', 'cosSigma', 'semanticWeight']);
      const next = {};
      if (chunk.chunkMaxChars !== undefined) { next.chunk = { ...(next.chunk || {}), maxChars: chunk.chunkMaxChars }; }
      if (chunk.jsonValueLimit !== undefined) { next.chunk = { ...(next.chunk || {}), jsonValueLimit: chunk.jsonValueLimit }; }
      if (chunk.headingContext !== undefined) { next.chunk = { ...(next.chunk || {}), headingContext: chunk.headingContext }; }
      if (chunk.hardSplitOversize !== undefined) { next.chunk = { ...(next.chunk || {}), hardSplitOversize: chunk.hardSplitOversize }; }
      if (chunk.fileNameContext !== undefined) { next.chunk = { ...(next.chunk || {}), fileNameContext: chunk.fileNameContext }; }
      if (Object.keys(embed).length) next.embed = embed;
      if (Object.keys(search).length) next.search = search;
      return next;
    }
    case 'agent': {
      const out = pick(['model', 'thinkingLevel', 'mode']);
      // 容错：模型常把模式写成 action / value
      const act = p.action ?? one;
      if (!out.mode && act !== undefined) {
        const v = String(act).toLowerCase();
        const alias = { 'read-only': 'readonly', readonly: 'readonly', 'read only': 'readonly', 只读: 'readonly',
          auto: 'auto', 自动: 'auto', confirm: 'confirm', 确认: 'confirm' };
        if (alias[v]) out.mode = alias[v];
        // 容错：action="mode" + value="readonly" 这种组合
        else if (v === 'mode' && one !== undefined && alias[String(one).toLowerCase()]) {
          out.mode = alias[String(one).toLowerCase()];
        }
      }
      if (!Object.keys(out).length && one !== undefined) out.model = String(one);
      return out;
    }
    case 'collections':
      return pick(['action', 'name', 'dirs']);
    case 'library':
      return pick(['action', 'baseDir', 'dsId']);
    default:
      return {};
  }
}
