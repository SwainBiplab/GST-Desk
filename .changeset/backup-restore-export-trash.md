---
'@gst/domain': minor
'@gst/db': minor
'web': minor
---

Backup, restore, export, import and the trash. A backup is one checked file (`.gstbk`, a ZIP with a manifest, a checksum per table and the attached files) made without stopping the app: automatically at a chosen time or on the first launch of the day, kept for 30 days and 12 months, copied to a folder you choose, and taken before an update changes your data. A restore is built in a second database beside the live one, checked, and only then swapped in, with a way back; a test kills the process mid-restore and finds the old database intact. One business can be restored or imported as a new business with new ids and a dry run first. JSON and CSV exports are documented in `docs/export-schema.md` and never contain tokens or PINs (the audit trail no longer records them either). Deleted drafts, parties and items wait 30 days in the trash. The browser asks for a download every 7 days and says plainly that its storage can be cleared; a failed backup shows on the bell. Copies to your own Google Drive or OneDrive are available in the desktop app with your own credentials. A 347 MB, 527,000-record book backs up in 17 s and restores in 58 s without holding the page for more than 240 ms.
