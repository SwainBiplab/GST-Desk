# GST Desk

Monorepo: `apps/web` (PWA), `apps/desktop` (Tauri v2), `packages/*`.

## Setup

1. Node >= 22 and pnpm 10 (`npm i -g pnpm`).
2. `pnpm install`
3. `pnpm dev` (web on http://localhost:1420), `pnpm build`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm e2e`.

## Desktop (Tauri) prerequisites

- Install Rust via https://rustup.rs
- **Linux:** `libwebkit2gtk-4.1-dev build-essential libssl-dev libayatana-appindicator3-dev librsvg2-dev`
- **macOS:** Xcode Command Line Tools
- **Windows:** Visual Studio Build Tools (C++ workload) and WebView2
- Run: `pnpm --filter desktop tauri dev`
