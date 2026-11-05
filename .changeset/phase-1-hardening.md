---
'web': minor
'@gst/i18n': minor
'@gst/print': patch
'@gst/drills': minor
---

Ready for a beta. The app has built-in help: press F1 on any screen, search it, and read a Getting started guide in six languages (drafts for review). Usage counters are off unless you turn them on in Settings, Privacy, count only the names of features, and show you exactly what would be sent. The web app now sets a Content-Security-Policy and framing protection. An accessibility audit of every screen in both modes and both themes found and fixed controls whose spoken names did not match what they show, unnamed text boxes, unlabelled preview pages and a card list that nested buttons wrongly. The invoice editor loads about 150 kB lighter because the PDF libraries are no longer bundled twice. A new set of drills damages a database and restores it, kills the app mid-invoice, and migrates an old database, and runs every night. Hindi is fully translated, including the help.
