// 耗时写操作（创建、重命名、移动、删除、副本、粘贴、元数据导入、屏蔽词表等）的统一反馈。
// 这些操作要等后端重扫并重建索引、「立即可检索」后才返回，慢主要慢在索引上：
// - 有按钮或对话框的：Button loading（对话框同时锁定），等待超过 WRITE_SLOW_MS 后忙碌文字换成
//   WRITE_SLOW_TEXT（组件内 useDelayedFlag(busy, WRITE_SLOW_MS)）；
// - 没有对话框的（副本、粘贴、拖放与批量操作、悬停卡片）：runWriteOp 用一条进行中的 toast 表示，
//   慢了追加同一句次要文字，完成或失败在同一条 toast 上收尾。
import { errorMessage, notify } from './notify';

export const WRITE_SLOW_MS = 1500;
export const WRITE_SLOW_TEXT = '正在更新索引…';

/** 无对话框的写操作：成功返回结果；失败已提示，返回 undefined */
export async function runWriteOp<T>(
  op: { pending: string; done: (r: T) => string; fail: string },
  fn: () => Promise<T>
): Promise<T | undefined> {
  const id = notify(op.pending, { busy: { slowText: WRITE_SLOW_TEXT, slowAfterMs: WRITE_SLOW_MS } });
  try {
    const r = await fn();
    notify(op.done(r), { id, kind: 'success' });
    return r;
  } catch (e) {
    notify(`${op.fail}：${errorMessage(e)}`, { id, kind: 'error' });
    return undefined;
  }
}
