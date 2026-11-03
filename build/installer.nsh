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
