// 打开中的编辑文档登记处：目录树的重命名 / 移动在执行前先 flush 打开中的文档，
// 避免缓冲区里未保存的输入随路径变化丢失。
export interface OpenDoc {
  path: string;
  isDirty: () => boolean;
  /** 把当前缓冲区按正常保存路径写回磁盘（含备份）；无修改时为空操作 */
  flush: () => Promise<void>;
}

const openDocs = new Map<string, OpenDoc>();

// 登记，返回解除登记函数（path 变化或卸载时调用）
export function registerOpenDoc(doc: OpenDoc): () => void {
  openDocs.set(doc.path, doc);
  return () => {
    if (openDocs.get(doc.path) === doc) openDocs.delete(doc.path);
  };
}

// flush 所有受影响的打开文档：路径相等，或位于被移动的文件夹内。
// 任一失败即抛出（调用方应中止后续操作并提示）。
export async function flushOpenEditor(affectedPath: string, isDir: boolean): Promise<void> {
  const targets = [...openDocs.values()].filter(
    (d) => d.path === affectedPath || (isDir && d.path.startsWith(affectedPath + '/'))
  );
  for (const t of targets) {
    await t.flush();
  }
}
