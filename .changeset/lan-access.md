---
'@gst/lan': minor
'@gst/db': minor
'web': minor
---

Tablets and phones on the shop network. A new `@gst/lan` package holds the rules: 8-digit one-time pairing codes (5 minutes, burn after 5 wrong tries), per-device tokens stored only as hashes and rotated after 30 days, three roles (full, counter, view), request limits and edit locks. The desktop gets an optional HTTPS server (a Rust crate with its own tests over real TLS) that serves the app and passes three routes to the window; the window answers from a whitelist of methods, so a tablet can bill and take payments but cannot query, export or change settings. Settings has a Tablets and phones page with the switch, addresses, certificate fingerprint, QR and code, and the device list. Two tablets billing at once produce numbers 1 to 20 with stock at 80. The Tauri glue is behind a `lan` cargo feature and has not been compiled on a real machine (B-143).
