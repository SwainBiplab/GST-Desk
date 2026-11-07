# @gst/lan

The rules of letting tablets and phones on the shop network use a desktop install, as pure TypeScript: pairing with a one-time code, device tokens (stored only as hashes, rotated every 30 days, revoked at once), roles, rate limits, single-writer edit locks, and the bridge that turns a request into a call on the repositories.

The desktop's Rust server (`apps/desktop/src-tauri/lan`) does only what Rust must: terminate TLS with a pinned self-signed certificate, serve the built web app, advertise `gstdesk.local`, and hand every `/pair` and `/rpc` request to the app. The app answers it with `LanBridge.handle`. Nothing about who may do what is decided in Rust.
