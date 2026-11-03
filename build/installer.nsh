; 升级（--updated）时沿用已有安装方式，跳过「为谁安装」页。
; 该宏由 multiUserUi.nsh 的安装模式页 Pre 调用（模板检查 !ifmacrodef customInstallmode，
; NSIS 宏名不区分大小写）；$hasPerMachineInstallation 已在 .onInit 的 initMultiUser 里赋值。
!macro customInstallMode
  ${if} ${isUpdated}
    ${if} $hasPerMachineInstallation == "1"
      StrCpy $isForceMachineInstall "1"
    ${else}
      StrCpy $isForceCurrentInstall "1"
    ${endif}
  ${endif}
!macroend

; 安装、升级、卸载前自动关闭本应用的全部进程，不弹窗询问（替换模板默认的检测逻辑）。
; 按可执行文件名匹配当前用户的进程，不限安装目录：卸载后仍残留的卡死进程、装在其他目录的旧版本
; 都会被关掉，否则新版启动时会被单实例锁拦下、表现为打不开界面。
; 先温和关闭让应用正常退出（未保存的编辑有本地草稿），最多等 5 秒，仍在运行就强制结束整个进程树。
!macro wbFindAppProcess
  nsExec::Exec `"$SYSDIR\cmd.exe" /C tasklist /FI "IMAGENAME eq ${APP_EXECUTABLE_FILENAME}" /FI "USERNAME eq %USERNAME%" /FO CSV /NH | "$SYSDIR\findstr.exe" /B /I /C:"\"${APP_EXECUTABLE_FILENAME}\""`
  Pop $R0 ; 0 = 找到进程
!macroend

!macro customCheckAppRunning
  !insertmacro wbFindAppProcess
  ${if} $R0 == 0
    DetailPrint "正在关闭正在运行的 ${PRODUCT_NAME}…"
    nsExec::Exec `"$SYSDIR\cmd.exe" /C taskkill /IM "${APP_EXECUTABLE_FILENAME}" /FI "USERNAME eq %USERNAME%"`
    Pop $R1
    ${For} $R1 1 10
      Sleep 500
      !insertmacro wbFindAppProcess
      ${IfThen} $R0 != 0 ${|} ${ExitFor} ${|}
    ${Next}
    ${if} $R0 == 0
      DetailPrint "强制结束未响应的 ${PRODUCT_NAME} 进程"
      nsExec::Exec `"$SYSDIR\cmd.exe" /C taskkill /F /T /IM "${APP_EXECUTABLE_FILENAME}" /FI "USERNAME eq %USERNAME%"`
      Pop $R1
      Sleep 1000
    ${endif}
  ${endif}
!macroend

; 升级时安装完成直接启动新版本并跳过完成页；首次安装仍显示完成页与「运行」勾选。
; 定义了本宏时模板不再自带 StartApp/MUI_FINISHPAGE_RUN（assistedInstaller.nsh），由这里补齐；
; $launchLink 在安装小节末尾已赋值（installSection.nsh）。
!macro customFinishPage
  Function StartApp
    ${if} ${isUpdated}
      StrCpy $1 "--updated"
    ${else}
      StrCpy $1 ""
    ${endif}
    ${StdUtils.ExecShellAsUser} $0 "$launchLink" "open" "$1"
  FunctionEnd

  Function finishPagePre
    ${if} ${isUpdated}
      HideWindow
      Call StartApp
      Abort
    ${endif}
  FunctionEnd

  !define MUI_PAGE_CUSTOMFUNCTION_PRE finishPagePre
  !define MUI_FINISHPAGE_RUN
  !define MUI_FINISHPAGE_RUN_FUNCTION "StartApp"
  !insertmacro MUI_PAGE_FINISH
!macroend
