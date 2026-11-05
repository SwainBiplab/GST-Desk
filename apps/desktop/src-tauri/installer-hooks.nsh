; Runs inside the NSIS installer and uninstaller that Tauri builds. The installer is per-user (no
; administrator rights). The app's data lives in the user's own data folder, not in the install folder,
; so removing the app never removes it; the uninstaller says so.

!macro NSIS_HOOK_POSTUNINSTALL
  ; silent uninstalls (an update, a script) stay silent
  IfSilent +2 0
  MessageBox MB_OK|MB_ICONINFORMATION "GST Desk has been removed.$\r$\n$\r$\nYour data and backups were not touched. They are still in:$\r$\n$APPDATA\GST Desk$\r$\n$\r$\nInstall GST Desk again to carry on where you left off, or delete that folder if you no longer need the data."
!macroend
