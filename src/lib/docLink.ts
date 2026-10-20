// 文档内相对链接的归一化解析：相对「当前文档所在目录」在知识库根内归一。
// 关键区别于旧 joinRel：越库根的 ../ 不再被静默钳位（旧实现把 ../../../x 错误地
// 解析成库内文件，最后报「文件不在扫描结果中」），而是判定为库外链接并给出绝对路径，
// 由界面弹确认框后用系统默认应用打开。
export interface ResolvedDocTarget {
  kind: 'internal' | 'external';
  /** internal：库内相对路径（posix）；external：绝对路径（posix 分隔符，Windows 亦可用） */
  path: string;
}

// 在绝对路径层级做 . / .. 归一（filesystem 根处 pop 为空操作，天然钳位）
function resolveAbs(baseAbs: string, rel: string): string {
  const parts = baseAbs.split('/').filter(Boolean);
  for (const seg of rel.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') parts.pop();
    else parts.push(seg);
  }
  // Windows 盘符（C:）作为首段时不能再补前导 /
  if (/^[a-zA-Z]:$/.test(parts[0] || '')) return parts.join('/');
  return '/' + parts.join('/');
}

export function resolveDocTarget(docDirRel: string, rel: string, baseDirAbs: string | null | undefined): ResolvedDocTarget {
  // 无库根信息时退化为库内解析（钳位语义，与旧行为一致）
  if (!baseDirAbs) {
    const parts = (docDirRel ? docDirRel.split('/') : []).filter(Boolean);
    for (const seg of rel.split('/')) {
      if (!seg || seg === '.') continue;
      if (seg === '..') parts.pop();
      else parts.push(seg);
    }
    return { kind: 'internal', path: parts.join('/') };
  }
  const base = baseDirAbs.replace(/\\/g, '/').replace(/\/+$/, '');
  const docDirAbs = base + (docDirRel ? '/' + docDirRel : '');
  const abs = resolveAbs(docDirAbs, rel);
  const prefix = base + '/';
  const baseLower = base.toLowerCase();
  const absLower = abs.toLowerCase();
  if (absLower === baseLower) return { kind: 'internal', path: '' };
  if (absLower.startsWith(prefix.toLowerCase())) return { kind: 'internal', path: abs.slice(prefix.length) };
  return { kind: 'external', path: abs };
}
