# @gst/ui

Design system for the web and desktop shells: tokens, theme, components, formatters.

## Layout

- `tokens/tokens.css` – CSS variables (`:root`, `[data-theme='dark']`, `[data-density]`). `theme.css` bridges them to Tailwind v4 utilities. `fonts.css` loads self-hosted fonts (fontsource packages, `font-display: swap`).
- `src/components` – Radix-based, shadcn-style components. `src/format` – the only formatters UI may use (`formatPaise`, `formatIndianNumber`, `parsePaise`, `formatBasisPoints`, `formatDate`, GSTIN check).
- `stories/` – Storybook 8. Use the toolbar to switch theme and density.

## Using it in an app

```css
@import 'tailwindcss';
@import '@gst/ui/tokens/theme.css';
@import '@gst/ui/tokens/fonts.css';
@source "../../../packages/ui/src";
```

Set `data-theme`, `data-density` and `lang` on `<html>`; `ThemeToggle`, `DensityToggle` and `LanguageSwitcher` do this.

## Adding a component

1. Create it in `src/components/`, build on a Radix primitive where one exists, and export it from `src/index.ts`.
2. Style only with token utilities (`bg-surface-1`, `text-fg-muted`, `h-(--control-h)`). Include `focusRing` on interactive elements.
3. Add a story to `stories/` and check it in all four theme/density combinations.

## Token rules

- **Never hard-code** colours, spacing, radii, font sizes, z-index or durations. Add or reuse a token.
- New colour pairs must pass WCAG AA; add them to `tokens/contrast.test.ts`.
- Money is integer paise (`bigint`/`number`), never floats. Format with `formatPaise` only.
- Nothing here may import from `apps/*`.

## Scripts

`pnpm test` (formatters, GSTIN, contrast) · `pnpm storybook` · `pnpm build-storybook` · `pnpm test-storybook --url <static server>`
