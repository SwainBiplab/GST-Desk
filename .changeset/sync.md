---
'@gst/sync': minor
'@gst/db': minor
'@gst/ai': minor
'api': minor
'web': minor
---

Sync (prompt 41). The PowerSync service streams each organisation's businesses to its devices by rules generated from the schema; devices upload to `/v1/sync/write`, where each local transaction is applied whole or becomes a conflict: non-money fields merge column by column, money and identity conflicts go to the inbox with both versions (keep mine or keep theirs), issued documents change only by revision, and every document issued or revised is priced again by the engine. Devices issue from number blocks the server hands out, then provisional numbers that the server replaces on sync (audited; a provisional document cannot be printed or shared). A local business can be converted to synced and detached again. The header pill shows local, synced, waiting, conflicts, offline or stuck, with a sheet. Tested against the real service; the chaos test passed 100 runs. The browser and desktop do not run the sync client yet (B-167, B-168), and the numbering needs a CA's sign-off (B-170).
