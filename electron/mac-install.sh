#!/bin/sh
# 退出后替换 .app 并重启（由 electron/macInstall.js 的 launchMacSwap 派发）。
# 用法: mac-install.sh <pid> <staged.app> <target.app> <resultFile> <dmgPath>
# 参数全部为本地路径，不拼接任何来自网络的字符串。
set -u
pid="$1"
staged="$2"
target="$3"
result_file="$4"
dmg="$5"
no_open="${WB_MAC_INSTALL_NO_OPEN:-}"

log() { echo "$(date '+%Y-%m-%dT%H:%M:%S') $*"; }

# JSON 字符串安全化：去掉引号/反斜杠/换行后嵌入
json_escape() {
  printf '%s' "$1" | tr -d '"\\' | tr '\n\r\t' '   '
}

write_result() { # ok reason detail
  ok="$1"
  reason="$(json_escape "$2")"
  detail="$(json_escape "$3")"
  mkdir -p "$(dirname "$result_file")"
  printf '{"ok":%s,"reason":"%s","detail":"%s","at":"%s"}\n' \
    "$ok" "$reason" "$detail" "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" > "$result_file"
}

# 测试开关：只记录将要打开什么，不真的 open（产品派发的 env 不含此变量）
open_app() {
  if [ "$no_open" = "1" ]; then
    log "would open $*"
  else
    open "$@"
  fi
}

log "mac-install 开始 pid=$pid staged=$staged target=$target"

# 1. 等原进程退出（最多 60 秒）
n=0
while kill -0 "$pid" 2>/dev/null; do
  n=$((n + 1))
  if [ "$n" -ge 300 ]; then
    log "等待原进程退出超时，放弃替换"
    write_result false "wait-exit-timeout" "waited 60s"
    exit 1
  fi
  sleep 0.2
done
log "原进程已退出，开始替换"

# 2. 旧版本挪为备份；失败（含「App 管理」拦截的 Operation not permitted）走手动回退
backup="$(dirname "$target")/.$(basename "$target").old-$(date +%s)"
if ! err=$(mv "$target" "$backup" 2>&1); then
  log "移走旧版本失败: $err"
  write_result false "move-old-failed" "$err"
  open_app "$dmg"
  open_app "$target"
  exit 1
fi
log "旧版本已备份: $backup"

# 3. 新版本就位；mv 失败改用 ditto，再失败则还原
if ! err=$(mv "$staged" "$target" 2>&1); then
  log "mv 新版本失败，改用 ditto: $err"
  if ! err=$(ditto "$staged" "$target" 2>&1); then
    log "ditto 新版本也失败: $err"
    if ! err2=$(mv "$backup" "$target" 2>&1); then
      log "还原旧版本失败，备份保留在 $backup: $err2"
      write_result false "restore-failed" "$backup"
      open_app "$dmg"
      exit 1
    fi
    log "已还原旧版本"
    write_result false "move-new-failed" "$err"
    open_app "$dmg"
    open_app "$target"
    exit 1
  fi
fi
log "新版本已就位"

# 4. 去隔离属性，避免 Gatekeeper 对替换后应用的首次打开拦截
xattr -dr com.apple.quarantine "$target" 2>/dev/null || true

# 5. 成功：写结果并重开新版本
write_result true "" ""
log "替换完成，重新打开新版本"
open_app "$target" --args --updated

# 6. 后台清理：备份与 staging
rm -rf "$backup" &
staging_dir="$(dirname "$staged")"
[ -d "$staging_dir" ] && rm -rf "$staging_dir" &
exit 0
