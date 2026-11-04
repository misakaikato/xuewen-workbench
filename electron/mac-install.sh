#!/bin/sh
# 退出后替换 .app 并重启（由 electron/macInstall.js 的 launchMacSwap 派发）。
# 用法: mac-install.sh <pid> <new.app> <target.app> <resultFile> <dmgPath> [backup]
# new.app 是准备阶段已放进目标同目录隐藏目录 .<名>.new-<ts>/ 的新版本（与目标同卷），本脚本只做两次改名
# （旧版 → 备份、新版 → 正式名），应用退出后到新版本打开前没有整份复制，应用从原位置消失的窗口
# 只剩两次同卷改名之间；改名后删掉空的 .<名>.new-<ts>/。backup 缺省时在目标同目录按 .<名>.old-<秒> 生成。
# 参数全部为本地路径，不拼接任何来自网络的字符串。
set -u
pid="$1"
new_app="$2"
target="$3"
result_file="$4"
dmg="$5"
target_dir="$(dirname "$target")"
target_base="$(basename "$target")"
stamp="$(date +%s)"
backup="${6:-$target_dir/.$target_base.old-$stamp}"
new_dir="$(dirname "$new_app")"
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

# 删掉新版本所在的 .<名>.new-<ts>/（只用 rmdir：不会删目标目录，也不会删非空目录；残留由下次启动清理）
remove_empty_new_dir() {
  if [ "$new_dir" != "$target_dir" ]; then rmdir "$new_dir" 2>/dev/null; fi
  return 0
}

# 失败分支收尾：删除准备好的新版本及其所在目录（备份由各分支自行处理）
cleanup_new() {
  rm -rf "$new_app"
  remove_empty_new_dir
}

log "mac-install 开始 pid=$pid new=$new_app target=$target"

# 1. 等原进程退出（最多 60 秒）
n=0
while kill -0 "$pid" 2>/dev/null; do
  n=$((n + 1))
  if [ "$n" -ge 300 ]; then
    log "等待原进程退出超时，放弃替换"
    write_result false "wait-exit-timeout" "waited 60s"
    cleanup_new
    exit 1
  fi
  sleep 0.2
done
log "原进程已退出，开始替换"

# 2. 目标目录不可写：旧版本挪不走，直接走手动回退
if [ ! -w "$target_dir" ]; then
  err="目标目录不可写: $target_dir"
  log "$err"
  write_result false "move-old-failed" "$err"
  cleanup_new
  open_app "$dmg"
  open_app "$target"
  exit 1
fi

# 3. 旧版本改名为备份；失败（含「App 管理」拦截的 Operation not permitted）走手动回退
if ! err=$(mv "$target" "$backup" 2>&1); then
  log "移走旧版本失败: $err"
  write_result false "move-old-failed" "$err"
  cleanup_new
  open_app "$dmg"
  open_app "$target"
  exit 1
fi
log "旧版本已备份: $backup"

# 4. 新版本改为正式名；目标路径已被占用时不改名（mv 会把新版本塞进那个目录里）
place_new() {
  if [ -e "$target" ] || [ -L "$target" ]; then
    echo "目标路径已存在: $target"
    return 1
  fi
  mv "$new_app" "$target"
}
if ! err=$(place_new 2>&1); then
  log "新版本改名失败: $err"
  # 还原前先删掉目标路径上的半截目录，否则 mv 会把备份塞进去
  if [ -e "$target" ] || [ -L "$target" ]; then rm -rf "$target"; fi
  if [ -e "$target" ] || [ -L "$target" ] || ! err2=$(mv "$backup" "$target" 2>&1); then
    log "还原旧版本失败，备份保留在 $backup: ${err2:-目标路径无法清空}"
    write_result false "restore-failed" "$backup"
    cleanup_new
    open_app "$dmg"
    exit 1
  fi
  log "已还原旧版本"
  write_result false "move-new-failed" "$err"
  cleanup_new
  open_app "$dmg"
  open_app "$target"
  exit 1
fi
log "新版本已就位"

# 5. 去隔离属性，避免 Gatekeeper 对替换后应用的首次打开拦截
xattr -dr com.apple.quarantine "$target" 2>/dev/null || true

# 6. 成功：写结果并重开新版本
write_result true "" ""
log "替换完成，重新打开新版本"
open_app "$target" --args --updated

# 7. 删掉已空的新版本目录；后台删除备份（备份路径记在 pending.json，没删完的下次启动补删）
remove_empty_new_dir
rm -rf "$backup" &
exit 0
