// 全局检索页：防抖、类型/目录筛选、排除目录、结果按文件归并、命中高亮与定位
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams, Link } from 'react-router-dom';
import { api } from '@/lib/api';
import { useApp } from '@/store/app';
import type { SearchResult } from '@/lib/types';
import { extIcon } from '@/components/RefChip';
import { SearchX, Loader2 } from 'lucide-react';

const TYPE_OPTIONS = [
  { v: '.md', label: 'Markdown' },
  { v: '.json', label: 'JSON' },
  { v: '.docx', label: 'DOCX' },
  { v: '.doc', label: 'DOC' },
];

function Highlight({ text, terms }: { text: string; terms: string[] }) {
  let parts: (string | React.ReactNode)[] = [text];
  terms.forEach((t, ti) => {
    const next: (string | React.ReactNode)[] = [];
    for (const p of parts) {
      if (typeof p !== 'string') {
        next.push(p);
        continue;
      }
      let rest = p;
      let idx = rest.toLowerCase().indexOf(t.toLowerCase());
      let k = 0;
      while (idx >= 0) {
        if (idx > 0) next.push(rest.slice(0, idx));
        next.push(<mark key={`${ti}-${k++}`}>{rest.slice(idx, idx + t.length)}</mark>);
        rest = rest.slice(idx + t.length);
        idx = rest.toLowerCase().indexOf(t.toLowerCase());
      }
      if (rest) next.push(rest);
    }
    parts = next;
  });
  return <>{parts}</>;
}

export default function Search() {
  const [params, setParams] = useSearchParams();
  const q = params.get('q') || '';
  const { dsId } = useApp();
  const [input, setInput] = useState(q);
  const [types, setTypes] = useState<string[]>([]);
  const [dir, setDir] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [terms, setTerms] = useState<string[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const navigate = useNavigate();
  const seqRef = useRef(0);

  const doSearch = useMemo(
    () => async (query: string, ty: string[], d: string) => {
      if (!query.trim()) {
        setResults([]);
        setTotal(0);
        return;
      }
      const seq = ++seqRef.current;
      setLoading(true);
      setErr(null);
      try {
        const r = await api.search(query, { types: ty, dir: d });
        if (seq !== seqRef.current) return; // 过期响应丢弃
        setResults(r.results);
        setTerms(r.terms);
        setTotal(r.total);
      } catch (e) {
        if (seq === seqRef.current) setErr((e as Error).message);
      } finally {
        if (seq === seqRef.current) setLoading(false);
      }
    },
    []
  );

  // 输入防抖
  useEffect(() => {
    const t = setTimeout(() => {
      setParams(input.trim() ? { q: input.trim() } : {}, { replace: true });
      doSearch(input, types, dir);
    }, 350);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [input, types, dir, dsId]);

  useEffect(() => setInput(q), [q]);

  return (
    <div className="max-w-3xl mx-auto py-6 px-4">
      <h1 className="text-lg font-bold mb-3">全局检索</h1>
      <input
        autoFocus
        value={input}
        onChange={(e) => setInput(e.target.value)}
        placeholder='多个关键词用空格分隔；精确短语用 "双引号"'
        className="w-full px-3 py-2.5 rounded-lg border border-input bg-card text-sm mb-3"
      />
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
          {loading ? '检索中…' : q ? `${total} 个文件命中` : ''}
        </span>
      </div>

      {err && (
        <div className="text-sm text-red-700 dark:text-red-400 border border-red-300 rounded p-3 mb-3">
          检索失败：{err}
          <button className="ml-2 underline" onClick={() => doSearch(input, types, dir)}>重试</button>
        </div>
      )}

      {!loading && q && total === 0 && !err && (
        <div className="text-center py-16 text-muted-foreground">
          <SearchX className="w-10 h-10 mx-auto mb-3" />
          <p className="text-sm">没有找到匹配「{q}」的内容</p>
          <p className="text-xs mt-1">试试减少关键词，或检查类型与目录筛选</p>
        </div>
      )}

      {!q && (
        <div className="text-xs text-muted-foreground border border-dashed border-border rounded-lg p-4">
          检索范围：当前资料库的文件名、相对路径、Markdown 正文、JSON 键和值、Word 提取正文。
          {loading && <Loader2 className="w-3.5 h-3.5 animate-spin inline ml-1" />}
        </div>
      )}

      <ul className="space-y-3">
        {results.map((r) => (
          <li key={r.file.path} className="bg-card border border-border rounded-lg p-3">
            <button
              className="flex items-center gap-2 font-medium text-sm hover:text-primary w-full text-left"
              onClick={() =>
                navigate(
                  '/read/' + r.file.path.split('/').map(encodeURIComponent).join('/') +
                    (terms[0] ? '?h=' + encodeURIComponent(terms[0]) : '')
                )
              }
            >
              {extIcon(r.file.ext)}
              <Highlight text={r.file.name} terms={terms} />
              <span className="text-xs text-muted-foreground font-normal truncate">{r.file.dir || '(根目录)'}</span>
            </button>
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
      {total > 200 && <div className="text-xs text-muted-foreground mt-3">仅展示前 200 个文件，请细化关键词</div>}
      <div className="mt-6 text-xs text-muted-foreground">
        找不到文件？<Link to="/browse" className="text-primary underline">浏览目录</Link>
      </div>
    </div>
  );
}
