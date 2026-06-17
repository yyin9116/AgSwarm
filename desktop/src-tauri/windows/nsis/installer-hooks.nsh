!macro NSIS_HOOK_PREINSTALL
  DetailPrint "Preparing AgSwarm Client for update..."
  FileOpen $0 "$TEMP\agswarm-preinstall.ps1" w
  FileWrite $0 "$$installDir = [IO.Path]::GetFullPath('$INSTDIR').TrimEnd('\') + '\';$\r$\n"
  FileWrite $0 "$$names = @('${MAINBINARYNAME}.exe', 'node.exe', 'pi-agent-session-bridge.exe');$\r$\n"
  FileWrite $0 "$$processes = Get-CimInstance Win32_Process | Where-Object { $$_.ExecutablePath -and $$names -contains $$_.Name -and ([IO.Path]::GetFullPath($$_.ExecutablePath) -like ($$installDir + '*')) };$\r$\n"
  FileWrite $0 "foreach ($$process in $$processes) { try { $$p = Get-Process -Id $$process.ProcessId -ErrorAction Stop; if ($$p.MainWindowHandle -ne 0) { [void]$$p.CloseMainWindow() } } catch {} }$\r$\n"
  FileWrite $0 "Start-Sleep -Milliseconds 1500;$\r$\n"
  FileWrite $0 "foreach ($$process in $$processes) { try { Stop-Process -Id $$process.ProcessId -Force -ErrorAction Stop } catch {} }$\r$\n"
  FileClose $0
  nsExec::ExecToLog 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$TEMP\agswarm-preinstall.ps1"'
  Delete "$TEMP\agswarm-preinstall.ps1"
  Sleep 500
!macroend
