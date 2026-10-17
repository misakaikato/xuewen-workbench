// 自动内链（词条）编辑器扩展：把服务端 /api/links/doc 的链接画成纯下划线标记装饰。
// - 装饰存于 StateField：文档变更时按变更映射移动，被编辑触及的区间直接丢弃；
//   保存 / 索引更新后重新拉取。wikilink 标记在光标所在行不显示（显示源码）。
// - Cmd/Ctrl+点击跳转目标（含标题锚点）；悬停显示目标标题与摘录，可「忽略此链接」
//   或「加入屏蔽词表」。[[ 触发词条自动补全。
// 所有装饰只影响显示，绝不改动文档字节。
import { StateEffect, StateField, Facet } from '@codemirror/state';
import type { Extension, Range, EditorState } from '@codemirror/state';
import { Decoration, EditorView, hoverTooltip } from '@codemirror/view';
import type { DecorationSet } from '@codemirror/view';
import type { CompletionContext, CompletionResult } from '@codemirror/autocomplete';
import { markdownLanguage } from '@codemirror/lang-markdown';
import { api } from '@/lib/api';
import type { DocLink } from '@/lib/api';
import { wikiNameAt } from '../../../server/linkMatch.js';

const alDocPath = Facet.define<string, string>({ combine: (v) => (v.length ? v[v.length - 1] : '') });

const setDocLinks = StateEffect.define<{ links: DocLink[]; seq: number }>();

interface AlState {
  links: DocLink[];
  seq: number;
  deco: DecorationSet;
}

// 光标所在行集合（wikilink 在活动行显示源码）
function activeLines(state: EditorState): Set<number> {
  const set = new Set<number>();
  for (const r of state.selection.ranges) {
    const a = state.doc.lineAt(r.from).number;
    const b = state.doc.lineAt(r.to).number;
    for (let n = a; n <= b; n++) set.add(n);
  }
  return set;
}

function buildDecorations(links: DocLink[], active: Set<number>, doc: { lineAt(p: number): { number: number } }): DecorationSet {
  const parts: Range<Decoration>[] = [];
  for (const l of links) {
    if (l.ignored || l.to <= l.from) continue;
    const cls = l.kind === 'auto' ? 'wb-autolink' : l.kind === 'wiki' ? 'wb-wikilink' : 'wb-wikilink-missing';
    if (l.kind !== 'auto') {
      // wikilink：活动行显示源码
      const a = doc.lineAt(l.from).number;
      const b = doc.lineAt(l.to).number;
      let onActive = false;
      for (let n = a; n <= b; n++) if (active.has(n)) onActive = true;
      if (onActive) continue;
    }
    parts.push(
      Decoration.mark({ class: cls, attributes: { 'data-al-kind': l.kind, 'data-al-term': l.term } }).range(l.from, l.to)
    );
  }
  return Decoration.set(parts, true);
}

const alField = StateField.define<AlState>({
  create() {
    return { links: [], seq: 0, deco: Decoration.none };
  },
  update(value, tr) {
    let links = value.links;
    let seq = value.seq;
    let rebuild = false;
    for (const e of tr.effects) {
      if (e.is(setDocLinks)) {
        links = e.value.links;
        seq = e.value.seq;
        rebuild = true;
      }
    }
    if (tr.docChanged) {
      // 区间随编辑映射；触及编辑内部的丢弃（含塌缩），避免陈旧错位的链接。
      // 端点统一取右侧（assoc=1）：链接前插入文字时标记整体右移保持完整，不在边界处误吸收/误丢弃
      const changed: [number, number][] = [];
      tr.changes.iterChangedRanges((_fA, _tA, fromB, toB) => changed.push([fromB, toB]));
      links = links
        .map((l) => {
          const from = tr.changes.mapPos(l.from, 1);
          const to = tr.changes.mapPos(l.to, 1);
          return from >= to ? null : { ...l, from, to };
        })
        .filter((l): l is DocLink => {
          if (!l) return false;
          return !changed.some(([a, b]) => l.from < b && l.to > a);
        });
      rebuild = true;
    }
    if (tr.selection) rebuild = true;
    if (!rebuild) return value;
    return {
      links,
      seq,
      deco: buildDecorations(links, activeLines(tr.state), tr.state.doc),
    };
  },
  provide: (f) => EditorView.decorations.from(f, (v) => v.deco),
});

// 找位置所在的链接（未忽略）
function linkAt(view: EditorView, pos: number): DocLink | null {
  const st = view.state.field(alField, false);
  if (!st) return null;
  return st.links.find((l) => !l.ignored && l.from <= pos && pos < l.to) || null;
}

// 悬停预览缓存
const previewCache = new Map<string, { title: string; excerpt: string }>();

async function previewOf(path: string) {
  const hit = previewCache.get(path);
  if (hit) return hit;
  try {
    const v = await api.linksPreview(path);
    previewCache.set(path, v);
    return v;
  } catch {
    return null;
  }
}

export interface AutoLinksOptions {
  /** Cmd/Ctrl+点击打开目标（应用内导航由上层决定） */
  onOpen: (target: { path: string; heading?: string | null }) => void;
  /** 歧义词条点击：交给上层展示候选 */
  onCandidates?: (term: string, candidates: string[]) => void;
}

// 拉取本文链接并注入编辑器（mount / 保存后 / 索引更新后调用）
export async function fetchDocLinks(view: EditorView, path: string, minSeq = 0): Promise<void> {
  let tries = 0;
  for (;;) {
    let r;
    try {
      r = await api.linksDoc(path);
    } catch {
      return;
    }
    if (r.ready && r.buildSeq >= minSeq) {
      view.dispatch({ effects: setDocLinks.of({ links: r.links, seq: r.buildSeq }) });
      return;
    }
    if (++tries > 30) return; // 索引迟迟未就绪：放弃本次（下次保存/更新会再拉）
    await new Promise((s) => setTimeout(s, 500));
  }
}

/** 外部已有链接数据时直接注入（与 fetchDocLinks 共用同一效果） */
export function pushDocLinks(view: EditorView | null, links: DocLink[], seq: number): void {
  if (!view) return;
  view.dispatch({ effects: setDocLinks.of({ links, seq }) });
}

// 词条自动补全：[[ 后按前缀查词条表
const wikiCompletionSource = async (context: CompletionContext): Promise<CompletionResult | null> => {
  const at = wikiNameAt(context.state.doc.toString(), context.pos);
  if (!at) return null;
  const r = await api.linksTerms(at.name).catch(() => null);
  if (!r) return null;
  return {
    from: at.from,
    options: r.terms.map((t) => ({
      label: t.term,
      detail: t.heading ? '标题锚点 · ' + t.path : t.path,
      apply: t.term + ']]',
    })),
    validFor: /^[^\]#[|\r\n]*$/,
  };
};

// 链接变更后广播（反向链接面板等监听刷新）
function notifyLinksUpdated() {
  window.dispatchEvent(new CustomEvent('wb-links-updated'));
}

export function autoLinks(opts: AutoLinksOptions): Extension {
  const theme = EditorView.theme({
    // 词条链接样式走 themes.css 的 .wb-autolink/.wb-wikilink/.wb-wikilink-missing
    // （与阅读页同源，三主题 + 深浅色全覆盖）；此处只定义悬停预览弹层
    '.cm-al-tip': {
      background: 'hsl(var(--card))',
      color: 'hsl(var(--foreground))',
      border: '1px solid hsl(var(--border))',
      borderRadius: '8px',
      padding: '8px 10px',
      maxWidth: '320px',
      fontSize: '12px',
      lineHeight: '1.6',
      boxShadow: '0 4px 14px hsl(var(--foreground) / 0.12)',
    },
    '.cm-al-tip-title': { fontWeight: '600', marginBottom: '4px' },
    '.cm-al-tip-body': { color: 'hsl(var(--muted-foreground))', maxHeight: '90px', overflow: 'hidden' },
    '.cm-al-tip-actions': { display: 'flex', gap: '6px', marginTop: '8px' },
    '.cm-al-tip-actions button': {
      border: '1px solid hsl(var(--border))',
      borderRadius: '6px',
      padding: '2px 8px',
      fontSize: '12px',
      background: 'hsl(var(--muted))',
      cursor: 'pointer',
    },
    '.cm-al-tip-actions button:hover': { borderColor: 'hsl(var(--primary))', color: 'hsl(var(--primary))' },
  });
  const tooltip = hoverTooltip((view, pos) => {
    const l = linkAt(view, pos);
    if (!l) return null;
    return {
      pos: l.from,
      end: l.to,
      create: () => {
        const dom = document.createElement('div');
        dom.className = 'cm-al-tip';
        const title = document.createElement('div');
        title.className = 'cm-al-tip-title';
        title.textContent = l.term;
        dom.appendChild(title);
        const body = document.createElement('div');
        body.className = 'cm-al-tip-body';
        body.textContent = '加载中…';
        dom.appendChild(body);
        if (l.target?.path) {
          previewOf(l.target.path).then((v) => {
            body.textContent = v ? v.excerpt || '（无摘录）' : l.target!.path;
          });
        } else if (l.candidates?.length) {
          body.textContent = '歧义词条：' + l.candidates.join('、');
        } else {
          body.textContent = '未找到词条：' + l.term;
        }
        if (l.kind === 'auto' && l.target?.path) {
          const actions = document.createElement('div');
          actions.className = 'cm-al-tip-actions';
          const mk = (label: string, fn: () => void) => {
            const b = document.createElement('button');
            b.textContent = label;
            // mousedown 只阻默认（避免抢焦点），动作挂在 click 上
            b.addEventListener('mousedown', (e) => e.preventDefault());
            b.addEventListener('click', () => fn());
            actions.appendChild(b);
            return b;
          };
          const path = String(view.state.facet(alDocPath));
          const norm = l.norm || l.term;
          mk('忽略此链接（本篇）', async () => {
            try {
              await api.linksIgnore({ path, term: norm, targetPath: l.target!.path, ignore: true });
              await fetchDocLinks(view, path);
              notifyLinksUpdated();
            } catch { /* 失败静默：下次悬停可重试 */ }
          });
          mk('加入屏蔽词表', async () => {
            try {
              const cur = await api.linksBlocklist();
              if (!cur.terms.includes(l.term)) await api.saveLinksBlocklist([...cur.terms, l.term]);
              await fetchDocLinks(view, path);
              notifyLinksUpdated();
            } catch { /* 同上 */ }
          });
          dom.appendChild(actions);
        }
        return { dom };
      },
    };
  });

  const plugin = EditorView.domEventHandlers({
    mousedown(event, view) {
      if (!(event.metaKey || event.ctrlKey)) return false;
      const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
      if (pos == null) return false;
      const l = linkAt(view, pos);
      if (!l) return false;
      event.preventDefault();
      if (l.target?.path) opts.onOpen(l.target);
      else if (l.candidates?.length) opts.onCandidates?.(l.term, l.candidates);
      return true;
    },
  });

  return [
    alField,
    tooltip,
    plugin,
    theme,
    markdownLanguage.data.of({ autocomplete: wikiCompletionSource }),
  ];
}

/** 供 Edit 页在打开 / 保存后触发拉取（扩展内事件处理也用它） */
export function linksExtensionFor(docPath: string, opts: AutoLinksOptions): Extension[] {
  return [alDocPath.of(docPath), autoLinks(opts)];
}
