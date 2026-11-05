# The landing page

Files: `apps/web/public/landing/` (`index.html`, `styles.css`, `main.js`, `favicon.svg`). They are plain static files copied into the web build, so they ship with the app on one domain, load nothing from other sites, and need no build step. The service worker does not treat `/landing/` as an app route (`navigateFallbackDenylist` in `vite.config.ts`).

## Who sees it

`public/entry-gate.js` runs before the app loads. At `/` a visitor is sent to `/landing/` only when all of these hold: not the desktop app, not an installed web app, no `?app` in the address, and none of `gst.entered`, `gst.device`, `gst.shell` in local storage (so nobody who has opened the app before is redirected). "Open the web app" links to `/?app`, which sets `gst.entered`. "Delete all my data" (`app/reset-local.ts`) keeps `gst.entered` (it holds no data), so the person returns to the welcome screen and not the landing page. The end-to-end config starts every test as a returning visitor; `e2e/landing.spec.ts` covers the first visit.

## Keeping it true

Every claim must be something the product does today, or be labelled as planned.

- **Our features and caveats:** check against `docs/releases/0.1.0-beta.1.md` and `docs/qa/beta-checklist.md` before editing, and update the page when a caveat there closes (for example when the updater key is set, or macOS and Linux installers exist).
- **The roadmap columns:** come from `prompts/00-INDEX.md`. They say "a plan, not a promise" and carry no dates.
- **The comparison table:** uses only what each vendor says on its own site, with "not stated" where it says nothing, and links its sources at the foot of the section. It was read in **November 2026**. Prices and plans change: re-read the linked pages before each release, and update the date in the page.
- **The sample invoice:** is labelled as sample figures. If you change a number, keep the arithmetic right (the end-to-end test checks the final total).

## Not done

Nothing is deployed from here. The desktop installer button is not on the page because no installer is released; add the download link when a release is published. A link from inside the app back to the landing page is not added.
