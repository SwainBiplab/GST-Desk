import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const css = readFileSync(join(import.meta.dirname, 'tokens.css'), 'utf8');

function block(selector: string): Record<string, string> {
  const start = css.indexOf(`${selector} {`);
  const body = css.slice(start, css.indexOf('}', start));
  return Object.fromEntries(
    [...body.matchAll(/--([\w-]+):\s*(#[0-9a-f]{6})/gi)].map((m) => [m[1]!, m[2]!]),
  );
}

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function ratio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

const light = block(':root');
const dark = { ...light, ...block("[data-theme='dark']") };

const pairs: [string, string][] = [
  ['color-fg', 'color-bg'],
  ['color-fg', 'color-surface-1'],
  ['color-fg', 'color-surface-2'],
  ['color-fg-muted', 'color-bg'],
  ['color-fg-muted', 'color-surface-1'],
  ['color-fg-muted', 'color-surface-2'],
  ['color-accent-fg', 'color-accent'],
  ['color-success-fg', 'color-success'],
  ['color-warning-fg', 'color-warning'],
  ['color-danger-fg', 'color-danger'],
  ['color-info-fg', 'color-info'],
  ['color-accent', 'color-bg'],
  ['color-success', 'color-bg'],
  ['color-warning', 'color-bg'],
  ['color-danger', 'color-bg'],
  ['color-info', 'color-bg'],
  ['color-danger', 'color-surface-2'],
];

describe.each([
  ['light', light],
  ['dark', dark],
])('WCAG AA contrast (%s)', (_name, theme) => {
  it.each(pairs)('%s on %s >= 4.5', (fg, bg) => {
    expect(ratio(theme[fg]!, theme[bg]!)).toBeGreaterThanOrEqual(4.5);
  });
});
