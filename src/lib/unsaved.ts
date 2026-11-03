// 「当前有未保存改动」登记表：编辑页与阅读页原位编辑在脏时注册、干净或卸载时注销。
// 安装更新（会关闭应用）前由 UpdateBanner 查询，有未保存改动则先弹确认。
export type UnsavedCheck = () => boolean;

const checks = new Set<UnsavedCheck>();

// 返回注销函数；同一函数重复注册无效（Set 去重）
export function registerUnsaved(check: UnsavedCheck): () => void {
  checks.add(check);
  return () => {
    checks.delete(check);
  };
}

export function hasUnsaved(): boolean {
  for (const check of checks) {
    try {
      if (check()) return true;
    } catch {
      // 检查函数异常按「无未保存」处理，不阻断安装
    }
  }
  return false;
}
