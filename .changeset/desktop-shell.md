---
'web': minor
'desktop': minor
'@gst/i18n': minor
---

The desktop app. Installers for Windows (per user, no administrator rights, about 8 MB), macOS and Linux; your data lives in your own folder (`%APPDATA%\GST Desk`, `~/Library/Application Support/GST Desk`, `~/.local/share/gst-desk`) and removing the app leaves it alone and says so. You can move the data folder from Settings, Desktop, and the move is copied and checked before the app switches. The database now runs through one connection owned by the app, so saving a bill is one all-or-nothing step exactly as in the browser. Updates are checked on launch and daily, downloaded quietly, and installed only when you press Restart to update; an update that is not signed with the right key is refused; stable or beta channel. A tray icon has New bill, Back up now and Open data folder; the app can start with your computer, shows a notification when the inbox has something new, opens backups (`.gstbk`) and `gstdesk://` links, lists the printers, and Report a problem saves a log file with no business data in it. Hindi is translated.
