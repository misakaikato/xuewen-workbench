// 文件扩展名图标（目录树 / 面包屑 / 搜索等处共用）
import { FileText, FileJson, FileType } from 'lucide-react';

export function extIcon(ext: string) {
  if (ext === '.json') return <FileJson className="w-3.5 h-3.5 inline" />;
  if (ext === '.doc' || ext === '.docx') return <FileType className="w-3.5 h-3.5 inline" />;
  return <FileText className="w-3.5 h-3.5 inline" />;
}
