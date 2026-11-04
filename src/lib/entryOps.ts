// 条目操作（重命名 / 移动 / 删除 / 副本）的统一执行：对话框、右键菜单、剪贴板与 e2e 测试钩子共用。
// 重命名 / 移动前先 flush 打开中的编辑器（失败中止），成功后刷新目录树、
// 迁移草稿键与标签、跟随导航到新路径（wbFollow，编辑页据此只重绑路径不重置缓冲区）。
// 反馈口径见 writeOp.ts：对话框里的操作由对话框显示忙碌态，副本走 runWriteOp 的进行中 toast。
import { api } from './api';
import { flushOpenEditor } from './openEditor';
import { migrateDrafts } from './drafts';
import { retargetTabs } from './tabs';
import { errorMessage, notify } from './notify';
import { runWriteOp } from './writeOp';

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
    return; // 当前地址不是合法编码的文档路径：没有可跟随的文档
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

// 写操作成功后刷新目录树；刷新失败时树与磁盘暂不一致，提示用户重扫（操作本身已成功，不回滚）
export async function refreshTreeAfterWrite(): Promise<void> {
  try {
    await ctx?.refreshTree();
  } catch (e) {
    notify('目录树刷新失败：' + errorMessage(e) + '，可点顶栏的重新扫描', { kind: 'error' });
  }
}

// 执行条目操作；成功返回 { newPath }（删除为 null），失败抛错（调用方负责提示）
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
  await refreshTreeAfterWrite();
  if (newPath !== null && dsId) migrateDrafts(dsId, action.path, newPath);
  retargetTabs(dsId, action.path, newPath, action.isDir);
  followNavigation(action, newPath);
  return { newPath };
}

// 创建副本（targetDir 省略 = 原目录；指定 = 粘贴到该目录）：没有对话框，经进行中 toast 反馈
export function runDuplicate(entry: Pick<EntryAction, 'path' | 'name'>, targetDir?: string) {
  const dsId = ctx?.dsId ?? null;
  const label = targetDir === undefined ? '创建副本' : '粘贴';
  return runWriteOp(
    { pending: `正在${label}「${entry.name}」…`, done: (r) => `已${label}：${r.path}`, fail: `${label}失败` },
    async () => {
      const r = await api.duplicateEntry({ dsId, path: entry.path, targetDir });
      await refreshTreeAfterWrite();
      return r;
    }
  );
}
