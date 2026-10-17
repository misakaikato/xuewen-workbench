// 条目操作（重命名 / 移动 / 删除）的统一执行：对话框与 e2e 测试钩子共用。
// 重命名 / 移动前先 flush 打开中的编辑器（失败中止），成功后刷新目录树、
// 迁移草稿键、跟随导航到新路径（wbFollow，编辑页据此只重绑路径不重置缓冲区）。
import { api } from './api';
import { flushOpenEditor } from './openEditor';
import { migrateDrafts } from './drafts';

export interface EntryAction {
  type: 'rename' | 'move' | 'delete';
  path: string;
  name: string;
  isDir: boolean;
  /** rename：新名称（可省略扩展名，服务端自动保留） */
  newName?: string;
  /** move：目标目录（数据源内相对路径，根目录为空串） */
  targetDir?: string;
}

export interface EntryContext {
  dsId: string | null;
  refreshTree: () => Promise<void>;
  navigate: (to: string, opts?: { replace?: boolean; state?: unknown }) => void;
  getLocation: () => { pathname: string } | null;
}

let ctx: EntryContext | null = null;

// 由布局层（Layout）登记应用上下文；e2e 测试钩子不依赖对话框也能直接调用
export function setEntryContext(next: EntryContext | null) {
  ctx = next;
}

const enc = (p: string) => p.split('/').map(encodeURIComponent).join('/');

// 跟随导航：当前阅读 / 编辑的文档受影响时，跳到新路径；被删除则回首页
function followNavigation(action: EntryAction, newPath: string | null) {
  const c = ctx;
  if (!c) return;
  const loc = c.getLocation();
  const m = loc?.pathname.match(/^\/(read|edit)\//);
  if (!m || !loc) return;
  let cur = '';
  try {
    cur = decodeURIComponent(loc.pathname.slice(m[0].length));
  } catch {
    return;
  }
  const affected = cur === action.path || (action.isDir && cur.startsWith(action.path + '/'));
  if (!affected) return;
  if (newPath === null) {
    c.navigate('/', { replace: true, state: { wbFollow: true } });
    return;
  }
  const next = newPath + cur.slice(action.path.length);
  c.navigate('/' + m[1] + '/' + enc(next), { replace: true, state: { wbFollow: true } });
}

// 执行条目操作；成功返回 { newPath }（删除为 null），失败抛错（调用方在对话框中展示）
export async function runEntryAction(action: EntryAction): Promise<{ newPath: string | null }> {
  const dsId = ctx?.dsId ?? null;
  if (action.type === 'rename' || action.type === 'move') {
    try {
      await flushOpenEditor(action.path, action.isDir);
    } catch (e) {
      throw new Error('保存打开中的文档失败，已中止：' + (e as Error).message);
    }
  }
  let newPath: string | null;
  if (action.type === 'rename') {
    const r = await api.renameEntry({ dsId, path: action.path, newName: action.newName || action.name });
    newPath = r.path;
  } else if (action.type === 'move') {
    const r = await api.moveEntry({ dsId, path: action.path, targetDir: action.targetDir || '' });
    newPath = r.path;
  } else {
    await api.deleteEntry({ dsId, path: action.path });
    newPath = null;
  }
  await ctx?.refreshTree().catch(() => {});
  if (newPath !== null && dsId) migrateDrafts(dsId, action.path, newPath);
  followNavigation(action, newPath);
  return { newPath };
}
