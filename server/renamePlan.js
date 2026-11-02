// 仅大小写变化的重命名决策（纯函数，供 relocate 与单测共用）。
// 输入：caseOnly（新旧名仅大小写不同）、targetExists（目标路径存在）、sameInode（目标与源同一文件）。
export function caseRenameAction({ caseOnly, targetExists, sameInode }) {
  if (!caseOnly) return 'direct';
  // 大小写敏感卷上真有两个文件（不同 inode）：目标已存在，拒绝
  if (targetExists && !sameInode) return 'conflict';
  // 不敏感卷上的同一文件，或目标不存在：经中间临时名两步改名
  return 'two-step';
}
