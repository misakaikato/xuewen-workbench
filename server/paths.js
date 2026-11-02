// 路径归属判断：单一真相源。所有「是否在目录内」的判断都用这里的 isWithin，
// 统一处理盘符根（Windows 根目录末尾已带分隔符）、realpath 与词法 .. 越界。
import path from 'node:path';

/** 判断 child 是否在 base 内（相等也算在内）。pathImpl 供测试用 path.win32 验证 Windows 语义。 */
export function isWithin(child, base, pathImpl = path) {
  const c = pathImpl.resolve(String(child));
  const b = pathImpl.resolve(String(base));
  if (c === b) return true;
  const prefix = b.endsWith(pathImpl.sep) ? b : b + pathImpl.sep;
  if (!c.startsWith(prefix)) return false;
  // 词法越界检查：解析后仍在 base 内，但原始路径里出现把层级压到 base 之上的 .. 段
  // （如盘符根上的 ..\x 会被 OS 归一到根，但语义上已越出库根）判越界。
  const rawChild = String(child);
  const rawBase = String(base);
  if (!rawChild.startsWith(rawBase)) return true;
  const rest = rawChild.slice(rawBase.length).replace(/^[\\/]+/, '');
  let depth = 0;
  for (const seg of rest.split(/[\\/]/)) {
    if (!seg || seg === '.') continue;
    if (seg === '..') {
      depth--;
      if (depth < 0) return false;
    } else {
      depth++;
    }
  }
  return true;
}
