// 语料引用解析弹层：corpusRefs 扩展点击后由宿主（Read/Edit）挂起，
// 行为对齐旧 RefChip——唯一命中直接跳转，重名列候选，缺失说明原因。
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '@/lib/api';
import type { FileEntry, RefResolution } from '@/lib/types';
import { AlertCircle, FileText } from 'lucide-react';

const encPath = (p: string) => p.split('/').map(encodeURIComponent).join('/');

export interface CorpusRefRequest {
  url: string;
  x: number;
  y: number;
}

function EntryRow({ t, onPick }: { t: FileEntry; onPick: (p: string) => void }) {
  return (
    <button
      className="w-full text-left px-2 py-1.5 rounded hover:bg-accent flex items-center gap-2 min-w-0"
      onClick={() => onPick(t.path)}
    >
      <FileText className="w-3.5 h-3.5 shrink-0 text-muted-foreground" />
      <span className="truncate mono text-xs">{t.path}</span>
    </button>
  );
}

export function CorpusRefPopover({
  req,
  onClose,
}: {
  req: CorpusRefRequest | null;
  onClose: () => void;
}) {
  const navigate = useNavigate();
  const [res, setRes] = useState<RefResolution | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    setRes(null);
    setErr(null);
    if (!req) return;
    const isCollection = req.url.startsWith('refc://');
    const payload = decodeURIComponent(req.url.replace(/^refc?:\/\//, ''));
    const [collection, name] = isCollection ? payload.split('|').map(decodeURIComponent) : [null, payload];
    let dead = false;
    api
      .resolveRef(name!, collection)
      .then((r) => !dead && setRes(r))
      .catch((e) => !dead && setErr(e.message));
    return () => {
      dead = true;
    };
  }, [req]);

  useEffect(() => {
    if (!req) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [req, onClose]);

  // 唯一命中：解析完成即跳（不弹层停留）
  useEffect(() => {
    if (res?.status === 'unique' && res.targets[0]) {
      onClose();
      navigate('/read/' + encPath(res.targets[0].path));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [res]);

  if (!req) return null;

  const go = (path: string) => {
    onClose();
    navigate('/read/' + encPath(path));
  };

  const x = Math.min(req.x, window.innerWidth - 360);
  const y = req.y + 18 > window.innerHeight - 260 ? Math.max(8, req.y - 250) : req.y + 18;

  return (
    <div className="fixed inset-0 z-50" onClick={onClose}>
      <div
        className="absolute bg-card border border-border rounded-lg shadow-xl p-3 w-96 max-w-[92vw] text-sm"
        style={{ left: Math.max(8, x), top: y }}
        onClick={(e) => e.stopPropagation()}
      >
        {err ? (
          <div className="flex items-start gap-2 text-muted-foreground">
            <AlertCircle className="w-4 h-4 mt-0.5 shrink-0 text-warning" />
            <div>解析请求失败：{err}</div>
          </div>
        ) : !res ? (
          <div className="text-muted-foreground">解析中…</div>
        ) : res.status === 'candidates' ? (
          <div>
            <div className="font-medium mb-2">找到 {res.targets.length} 个同名目标，请选择：</div>
            <ul className="max-h-64 overflow-auto">
              {res.targets.map((t) => (
                <li key={t.path}>
                  <EntryRow t={t} onPick={go} />
                </li>
              ))}
            </ul>
          </div>
        ) : (
          <div className="flex items-start gap-2 text-muted-foreground">
            <AlertCircle className="w-4 h-4 mt-0.5 shrink-0 text-warning" />
            <div>
              <div className="text-foreground mb-1">未找到引用目标</div>
              <div className="text-xs">{res.reason || '该名称不在当前语料库中。'}</div>
              {res.suggestions && res.suggestions.length > 0 && (
                <div className="mt-2">
                  <div className="text-xs mb-1">相近文件：</div>
                  <ul>
                    {res.suggestions.slice(0, 5).map((t) => (
                      <li key={t.path}>
                        <EntryRow t={t} onPick={go} />
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// 歧义词条候选弹层：wikilink / 自动内链点击命中多个目标时由宿主挂起
export interface PathListRequest {
  title: string;
  paths: string[];
  x: number;
  y: number;
}

export function PathListPopover({ req, onClose }: { req: PathListRequest | null; onClose: () => void }) {
  const navigate = useNavigate();
  useEffect(() => {
    if (!req) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [req, onClose]);
  if (!req) return null;
  const go = (path: string) => {
    onClose();
    navigate('/read/' + encPath(path));
  };
  const x = Math.min(req.x, window.innerWidth - 360);
  const y = req.y + 18 > window.innerHeight - 220 ? Math.max(8, req.y - 210) : req.y + 18;
  return (
    <div className="fixed inset-0 z-50" onClick={onClose}>
      <div
        className="absolute bg-card border border-border rounded-lg shadow-xl p-3 w-96 max-w-[92vw] text-sm"
        style={{ left: Math.max(8, x), top: y }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="font-medium mb-2">{req.title}</div>
        <ul className="max-h-64 overflow-auto">
          {req.paths.map((p) => (
            <li key={p}>
              <button
                className="w-full text-left px-2 py-1.5 rounded hover:bg-accent flex items-center gap-2 min-w-0"
                onClick={() => go(p)}
              >
                <FileText className="w-3.5 h-3.5 shrink-0 text-muted-foreground" />
                <span className="truncate mono text-xs">{p}</span>
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
