// 全局检索页：双模式（精确/智能 RAG）+ 类型/目录筛选、排除目录、结果按文件归并、命中高亮与定位
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams, Link } from 'react-router-dom';
import { api } from '@/lib/api';
import type { RagSearchResponse } from '@/lib/api';
import { useApp } from '@/store/app';
import type { SearchResult } from '@/lib/types';
import { extIcon } from '@/lib/extIcon';
import { SearchX, Loader2, Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { normalizeText } from '../../server/linkMatch.js';

// 搜索会话缓存：路由离开 Search 后返回时恢复结果与滚动位置，免去重新检索。
// key = dsId|mode|q；筛选与智能 limit 一并随缓存恢复（不在 URL 里的状态也不丢）
interface SearchSession {
  key: string;
  input: string;
  types: string[];
  dir: string;
  smartLimit: number;
  results: SearchResult[];
  smart: RagSearchResponse | null;
  terms: string[];
  total: number;
  scrollTop: number;
}
let searchSession: SearchSession | null = null;

const TYPE_OPTIONS = [
  { v: '.md', label: 'Markdown' },
  { v: '.txt', label: 'TXT' },
  { v: '.json', label: 'JSON' },
  { v: '.docx', label: 'DOCX' },
  { v: '.doc', label: 'DOC' },
  { v: '.html', label: 'HTML' },
];

function Highlight({ text, terms, emphasis }: { text: string; terms: string[]; emphasis?: boolean }) {
  const normalized = normalizeText(text).toLowerCase();
  const matches: { from: number; to: number }[] = [];
  for (const term of terms.filter(Boolean)) {
    const needle = normalizeText(term).toLowerCase();
    for (let at = normalized.indexOf(needle); at >= 0; at = normalized.indexOf(needle, at + needle.length)) {
      matches.push({ from: at, to: at + needle.length });
    }
  }
  matches.sort((a, b) => a.from - b.from || b.to - a.to);
  const merged: typeof matches = [];
  for (const hit of matches) {
    const prev = merged[merged.length - 1];
    if (prev && hit.from <= prev.to) prev.to = Math.max(prev.to, hit.to);
    else merged.push({ ...hit });
  }
  let from = 0;
  return <>{merged.map((hit) => {
    const before = text.slice(from, hit.from);
    from = hit.to;
    return <span key={hit.from}>{before}<mark className={emphasis ? 'bg-warning/30 text-foreground rounded-sm px-0.5' : undefined}>{text.slice(hit.from, hit.to)}</mark></span>;
  })}{text.slice(from)}</>;
}

export default function Search() {
  const [params, setParams] = useSearchParams();
  const q = params.get('q') || '';
  const mode = params.get('mode') === 'exact' ? 'exact' : 'smart'; // 默认智能检索（精确用 ?mode=exact）
  const { dsId } = useApp();
  const [input, setInput] = useState(q);
  const [types, setTypes] = useState<string[]>([]);
  const [dir, setDir] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [smart, setSmart] = useState<RagSearchResponse | null>(null);
  const [smartLimit, setSmartLimit] = useState(50);
  const [smartErr, setSmartErr] = useState<string | null>(null);
  const [terms, setTerms] = useState<string[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const navigate = useNavigate();
  const seqRef = useRef(0);
  const hydratedRef = useRef(false);
  // 最新状态镜像：供卸载时保存会话读取（cleanup 闭包捕获的是旧渲染值）
  const latestRef = useRef({ input, types, dir, mode, smartLimit, results, smart, terms, total, scroll: 0 });
  latestRef.current = { input, types, dir, mode, smartLimit, results, smart, terms, total, scroll: latestRef.current.scroll };

  // 会话恢复：同一库同一查询返回时直接还原（跳过重新检索），并恢复滚动位置
  useEffect(() => {
    const q0 = new URLSearchParams(window.location.search).get('q') || '';
    const m0 = new URLSearchParams(window.location.search).get('mode') === 'exact' ? 'exact' : 'smart';
    const key = `${dsId}|${m0}|${q0}`;
    // 空会话不恢复（StrictMode 双挂载首轮会保存空态；也避免空查询恢复无意义状态）
    if (searchSession && searchSession.key === key && searchSession.input === q0 &&
        (searchSession.results.length > 0 || searchSession.smart)) {
      const c = searchSession;
      setInput(c.input);
      setTypes(c.types);
      setDir(c.dir);
      setSmartLimit(c.smartLimit);
      setResults(c.results);
      setSmart(c.smart);
      setTerms(c.terms);
      setTotal(c.total);
      hydratedRef.current = true;
      // 恢复滚动：等列表渲染出足够高度再落。不依赖 rAF（后台标签页会暂停帧回调），
      // 用短间隔定时器轮询，设足即停
      let tries = 0;
      const restoreScroll = () => {
        const main = document.querySelector('main');
        if (!main) return;
        main.scrollTop = c.scrollTop;
        if (main.scrollTop < c.scrollTop - 2 && ++tries < 30) setTimeout(restoreScroll, 33);
      };
      setTimeout(restoreScroll, 0);
    }
    // 滚动位置持续记录到镜像：卸载时 React 已移除 DOM、main 高度塌缩、
    // scrollTop 被钳为 0——cleanup 里读 DOM 拿到的永远是 0
    const main = document.querySelector('main');
    const onScroll = () => {
      if (!main) return;
      // 路由切换时内容塌缩会触发 scrollTop→0 的 scroll 事件——不覆盖已记录的
      // 真实位置（塌缩态 scrollHeight 远小于正常列表高度）
      if (main.scrollHeight - main.clientHeight < main.clientHeight) return;
      latestRef.current.scroll = main.scrollTop;
    };
    main?.addEventListener('scroll', onScroll, { passive: true });
    const save = () => {
      const l = latestRef.current;
      searchSession = {
        key: `${dsId}|${l.mode}|${l.input.trim()}`,
        input: l.input.trim(),
        types: l.types, dir: l.dir, smartLimit: l.smartLimit,
        results: l.results, smart: l.smart, terms: l.terms, total: l.total,
        scrollTop: l.scroll,
      };
    };
    return () => {
      main?.removeEventListener('scroll', onScroll);
      save(); // 组件卸载（路由切走）即保存
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const doSearch = useMemo(
    () => async (query: string, ty: string[], d: string, m: 'exact' | 'smart') => {
      if (!query.trim()) {
        setResults([]);
        setSmart(null);
        setTotal(0);
        setSmartErr(null);
        return;
      }
      const seq = ++seqRef.current;
      setLoading(true);
      setErr(null);
      setSmartErr(null);
      try {
        if (m === 'smart') {
          const r = await api.ragSearch(query, smartLimit);
          if (seq !== seqRef.current) return;
          setSmart(r);
          setTotal(r.hits.length);
          // 智能模式高亮：查询词 + 简繁各一形态
          setTerms(query.split(/\s+/).filter(Boolean));
        } else {
          const r = await api.search(query, { types: ty, dir: d });
          if (seq !== seqRef.current) return;
          setResults(r.results);
          setTerms(r.terms);
          setTotal(r.total);
        }
      } catch (e) {
        if (seq === seqRef.current) {
          if (m === 'smart') setSmartErr((e as Error).message);
          else setErr((e as Error).message);
        }
      } finally {
        if (seq === seqRef.current) setLoading(false);
      }
    },
    [smartLimit]
  );

  // 输入防抖
  useEffect(() => {
    const p: Record<string, string> = input.trim() ? { q: input.trim() } : {};
    if (mode === 'exact') p.mode = 'exact';
    if (hydratedRef.current) {
      hydratedRef.current = false; // 会话已恢复：本轮跳过重查，闪退即无
      return;
    }
    const t = setTimeout(() => {
      setParams(p, { replace: true });
      doSearch(input, types, dir, mode);
    }, mode === 'smart' ? 500 : 350);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [input, types, dir, dsId, mode, smartLimit]);

  useEffect(() => setInput(q), [q]);

  return (
    <div className="max-w-3xl mx-auto py-6 px-4">
      <h1 className="text-lg font-semibold mb-3 flex items-center gap-3">
        全局检索
        <span className="inline-flex rounded-lg border border-border overflow-hidden text-xs font-normal">
          <button
            className={`px-3 py-1 flex items-center gap-1 ${mode === 'exact' ? 'bg-primary text-primary-foreground' : 'hover:bg-accent text-muted-foreground'}`}
            onClick={() => setParams(input.trim() ? { q: input.trim(), mode: 'exact' } : { mode: 'exact' }, { replace: true })}
          >
            精确
          </button>
          <button
            className={`px-3 py-1 flex items-center gap-1 ${mode === 'smart' ? 'bg-primary text-primary-foreground' : 'hover:bg-accent text-muted-foreground'}`}
            onClick={() => setParams(input.trim() ? { q: input.trim() } : {}, { replace: true })}
            title="语义+关键词混合检索（RAG），支持繁简互通"
          >
            <Sparkles className="w-3 h-3" />智能
          </button>
        </span>
      </h1>
      <input
        autoFocus
        value={input}
        onChange={(e) => setInput(e.target.value)}
        placeholder={mode === 'smart' ? '用自然语言提问，如：孔子怎么看礼' : '多个关键词用空格分隔；精确短语用 "双引号"'}
        className="w-full px-3 py-2.5 rounded-lg border border-input bg-card text-sm mb-3"
      />
      {mode === 'exact' && (
      <div className="flex items-center gap-3 mb-4 flex-wrap text-xs">
        <div className="flex items-center gap-1">
          {TYPE_OPTIONS.map((t) => (
            <button
              key={t.v}
              className={`px-2 py-1 rounded border ${
                types.includes(t.v) ? 'border-primary text-primary' : 'border-border text-muted-foreground hover:bg-accent'
              }`}
              onClick={() => setTypes((prev) => (prev.includes(t.v) ? prev.filter((x) => x !== t.v) : [...prev, t.v]))}
            >
              {t.label}
            </button>
          ))}
        </div>
        <input
          value={dir}
          onChange={(e) => setDir(e.target.value)}
          placeholder="限定目录（如 笔记/主题）"
          className="px-2 py-1 rounded border border-input bg-card w-44"
        />
        {(types.length > 0 || dir) && (
          <button className="text-primary underline" onClick={() => { setTypes([]); setDir(''); }}>
            清除筛选
          </button>
        )}
        <span className="text-muted-foreground ml-auto stat-num">
          {loading ? (
            <span className="inline-flex items-center gap-1.5"><Loader2 className="w-3 h-3 animate-spin" />检索中…</span>
          ) : q ? `${total} 个文件命中` : ''}
        </span>
      </div>
      )}
      {mode === 'smart' && (
        <div className="flex items-center gap-2 mb-4 text-xs text-muted-foreground flex-wrap">
          {smart && q && (
            <span>
              共 <span className="stat-num">{smart.total ?? smart.hits.length}</span> 段命中
              {(smart.total ?? 0) > smart.hits.length && <span className="text-muted-foreground">（显示前 {smart.hits.length}）</span>}
              · 耗时 {smart.took}ms · 后端 {smart.backend}
            </span>
          )}
          <span className="flex-1" />
          <Link to="/rag" className="text-primary underline">RAG 管理</Link>
        </div>
      )}

      {err && (
        <div className="text-sm text-destructive border border-destructive/40 bg-destructive/10 rounded p-3 mb-3">
          检索失败：{err}
          <button className="ml-2 underline" onClick={() => doSearch(input, types, dir, 'exact')}>重试</button>
        </div>
      )}

      {/* 结果区加载态：检索中在结果区顶部给出明确提示，旧结果淡出保留（防闪烁） */}
      {loading && q && (
        <div className="mb-3 flex items-center gap-2 text-sm text-muted-foreground border border-border rounded-lg px-3 py-2.5 bg-card animate-fade-in" role="status">
          <Loader2 className="w-4 h-4 animate-spin" />
          正在检索「{q}」…
        </div>
      )}

      {mode === 'smart' && !loading && q && smart && smart.hits.length === 0 && !smartErr && (
        <div className="text-center py-16 text-muted-foreground">
          <SearchX className="w-10 h-10 mx-auto mb-3" />
          <p className="text-sm">没有找到与「{q}」语义相近的内容</p>
          <p className="text-xs mt-1">
            {smart.candidates ? `候选：关键词 ${smart.candidates.fts} 段 · 语义 ${smart.candidates.cos} 段。` : ''}
            可换一种说法，或切到「精确」按关键词检索。
          </p>
          <div className="mt-3 flex items-center justify-center gap-2">
            <button className="text-xs px-3 py-1.5 rounded border border-border hover:bg-accent transition-colors"
              onClick={() => setParams(input.trim() ? { q: input.trim(), mode: 'exact' } : { mode: 'exact' }, { replace: true })}>
              切到精确检索
            </button>
            <Link to="/rag" className="text-xs px-3 py-1.5 rounded border border-border hover:bg-accent transition-colors">检查索引与模型</Link>
          </div>
        </div>
      )}
      {mode === 'exact' && !loading && q && total === 0 && !err && (
        <div className="text-center py-16 text-muted-foreground">
          <SearchX className="w-10 h-10 mx-auto mb-3" />
          <p className="text-sm">没有找到匹配「{q}」的内容</p>
          <p className="text-xs mt-1">试试减少关键词，或检查类型与目录筛选</p>
        </div>
      )}

      {!q && (
        <div className="text-xs text-muted-foreground border border-dashed border-border rounded-lg p-4">
          {mode === 'smart'
            ? '智能检索：语义 + 关键词混合，支持繁简互通；需要先在 RAG 管理页就绪模型并建索引。'
            : '检索范围：当前知识库的文件名、相对路径、Markdown 正文、JSON 键和值、Word 提取正文。'}
          {loading && <Loader2 className="w-3.5 h-3.5 animate-spin inline ml-1" />}
        </div>
      )}

      {mode === 'smart' && smartErr && q && (
        <div className="text-sm text-destructive border border-destructive/40 bg-destructive/10 rounded p-3 mb-3">
          {smartErr.includes('索引为空') ? (
            <>智能检索尚未建索引。去 <Link to="/rag" className="text-primary underline">RAG 管理</Link> 下载模型并构建索引。</>
          ) : (
            <>检索失败：{smartErr}</>
          )}
        </div>
      )}

      {mode === 'smart' && !loading && q && !smartErr && smart && smart.hits.length === 0 && (
        <div className="text-center py-16 text-muted-foreground">
          <SearchX className="w-10 h-10 mx-auto mb-3" />
          <p className="text-sm">知识库中没有找到与「{q}」相关的内容</p>
          <p className="text-xs mt-1">换个说法试试，或用「精确」模式查关键词</p>
        </div>
      )}

      {mode === 'smart' && smart && smart.hits.length > 0 && (
        <ul className="space-y-3 wb-selectable">
          {smart.hits.map((h, i) => (
            <li
              key={h.path + ':' + h.ordinal + ':' + i}
              className="bg-card border border-border rounded-lg p-3 cursor-pointer hover:border-primary/50 hover:shadow-sm transition-all"
              onClick={() => {
                  // ?h= 与 #锚点同带：词在正文则高亮并定位首个命中；
                  // 语义命中常不含原词，此时回退到命中块的标题锚点
                  const heading = h.headingPath ? h.headingPath.split(' > ').pop() : '';
                  const base = '/read/' + h.path.split('/').map(encodeURIComponent).join('/');
                  const term = input.trim().split(/\s+/)[0] || '';
                  const query = new URLSearchParams();
                  if (term) query.set('h', term);
                  if (h.location) {
                    query.set('hit', h.location.text);
                    query.set('occ', String(h.location.occurrence));
                  }
                  navigate(base + (query.size ? '?' + query.toString() : '') + (heading ? '#' + encodeURIComponent(heading) : ''));
                }}
            >
              <div className="flex items-center gap-2 text-sm font-semibold">
                {extIcon(h.path.includes('.') ? ('.' + h.name.split('.').pop() as string) : '')}
                <span className="truncate">{h.name}</span>
                {h.headingPath && (
                  <span className="text-xs text-muted-foreground font-normal truncate">{h.headingPath}</span>
                )}
                <span className="ml-auto flex items-center gap-1 text-xs text-muted-foreground font-normal shrink-0">
                  {h.bm25 && <span className="px-1 rounded bg-muted">关键词</span>}
                  {h.cos != null && <span className="px-1 rounded bg-muted">语义 {h.cos.toFixed(2)}</span>}
                </span>
              </div>
              <div className="mt-1.5 text-xs text-muted-foreground leading-relaxed">
                <Highlight text={h.snippet} terms={terms} emphasis />
              </div>
            </li>
          ))}
        </ul>
      )}
      {mode === 'smart' && smart && (smart.total ?? smart.hits.length) > smart.hits.length && (
        <Button
          variant="outline"
          className="mt-3 w-full text-xs text-muted-foreground"
          disabled={loading}
          onClick={() => setSmartLimit((n) => Math.min(500, n * 2))}
        >
          {loading ? (
            <><Loader2 className="w-3.5 h-3.5 animate-spin" />加载中…</>
          ) : (
            `显示更多（还有 ${(smart.total ?? 0) - smart.hits.length} 段）`
          )}
        </Button>
      )}

      {mode === 'exact' && (
      <ul className="space-y-3 wb-selectable">
        {results.map((r) => (
          <li
            key={r.file.path}
            className="bg-card border border-border rounded-lg p-3 cursor-pointer hover:border-primary/50 hover:shadow-sm transition-all"
            onClick={() =>
              navigate(
                '/read/' + r.file.path.split('/').map(encodeURIComponent).join('/') +
                  (terms[0] ? '?h=' + encodeURIComponent(terms[0]) : '')
              )
            }
          >
            <div className="flex items-center gap-2 text-sm font-semibold">
              {extIcon(r.file.ext)}
              <Highlight text={r.file.name} terms={terms} />
              <span className="text-xs text-muted-foreground font-normal truncate">{r.file.dir || '(根目录)'}</span>
            </div>
            <div className="mt-1.5 space-y-1">
              {r.matches
                .filter((m) => m.field === 'content')
                .slice(0, 3)
                .map((m, i) => (
                  <div key={i} className="text-xs text-muted-foreground leading-relaxed">
                    <Highlight text={m.snippet} terms={terms} />
                  </div>
                ))}
              {r.matches.some((m) => m.field === 'name') && (
                <div className="text-xs text-primary">文件名命中</div>
              )}
            </div>
          </li>
        ))}
      </ul>
      )}
      {mode === 'exact' && total > 200 && <div className="text-xs text-muted-foreground mt-3">仅展示前 200 个文件，请细化关键词</div>}
      <div className="mt-6 text-xs text-muted-foreground">
        找不到文件？<Link to="/browse" className="text-primary underline">浏览目录</Link>
      </div>
    </div>
  );
}
