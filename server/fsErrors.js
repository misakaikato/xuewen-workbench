// 文件系统错误 → 给用户看的中文原因。界面提示不直接露出 ENOENT 一类的系统错误码。
const REASONS = {
  ENOENT: '不存在或已被移走',
  EACCES: '没有访问权限',
  EPERM: '没有访问权限',
  ENOTDIR: '不是文件夹',
  EBUSY: '被其他程序占用',
  ETIMEDOUT: '访问超时',
  EIO: '读写出错（磁盘或网络盘异常）',
  ELOOP: '符号链接循环',
  EMFILE: '打开的文件过多',
  ENFILE: '打开的文件过多',
};

export function fsErrorText(err) {
  const code = err && typeof err === 'object' ? err.code : undefined;
  if (code && REASONS[code]) return REASONS[code];
  if (code) return `访问失败（${code}）`;
  return String((err && err.message) || err || '未知错误');
}
