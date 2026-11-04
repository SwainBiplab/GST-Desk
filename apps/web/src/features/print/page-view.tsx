import {
  qrMatrix,
  splitRuns,
  type FontFamily,
  type Item,
  type LayoutPage,
  type TextMeasurer,
} from '@gst/print';
import { cssFamily } from '@gst/print/fonts.web';
import { Fragment, memo, useMemo, type CSSProperties, type ReactElement } from 'react';

/** Points to CSS pixels at 100% zoom (96 dpi). */
const PX = 96 / 72;

/** Test hooks for the parts of a document that tests (and people) ask about by name. */
const TEST_ID: Record<string, string> = {
  title: 'preview-title',
  number: 'preview-number',
  total: 'preview-total',
  business: 'preview-business',
  party: 'preview-party',
  words: 'preview-words',
  foreign: 'preview-foreign',
};

type TextItem = Extract<Item, { t: 'text' }>;

/** Group consecutive items of one line item (`line:3:*`) or one multi-line block (notes, terms). */
function groups(items: readonly Item[]): { key: string | null; kind: string; items: Item[] }[] {
  const out: { key: string | null; kind: string; items: Item[] }[] = [];
  for (const it of items) {
    const tag = it.t === 'text' ? it.tag : undefined;
    const lineKey = tag?.startsWith('line:') ? tag.split(':').slice(0, 2).join(':') : null;
    const blockKey = tag === 'notes' || tag === 'terms' ? tag : null;
    const key = lineKey ?? blockKey;
    const last = out[out.length - 1];
    if (key && last && last.key === key) last.items.push(it);
    else out.push({ key, kind: lineKey ? 'line' : (blockKey ?? 'plain'), items: [it] });
  }
  return out;
}

function QrDraw({ it }: { it: Extract<Item, { t: 'qr' }> }) {
  const q = useMemo(() => qrMatrix(it.data), [it.data]);
  const quiet = 1;
  const cell = it.size / (q.size + quiet * 2);
  const rects: ReactElement[] = [];
  for (let r = 0; r < q.size; r++) {
    let c = 0;
    while (c < q.size) {
      if (!q.dark[r * q.size + c]) {
        c++;
        continue;
      }
      let end = c;
      while (end < q.size && q.dark[r * q.size + end]) end++;
      rects.push(
        <rect
          key={`${r}-${c}`}
          x={it.x + (c + quiet) * cell}
          y={it.y + (r + quiet) * cell}
          width={(end - c) * cell}
          height={cell}
          fill="#000"
        />,
      );
      c = end;
    }
  }
  return (
    <g data-testid="preview-qr">
      <rect x={it.x} y={it.y} width={it.size} height={it.size} fill="#fff" />
      {rects}
    </g>
  );
}

function TextDraw({ it, m, ascent }: { it: TextItem; m: TextMeasurer; ascent: number }) {
  const runs = splitRuns(it.text);
  const base = it.y + ascent * it.size;
  const width = m.width(it.text, it.weight, it.size);
  const transform = it.rotate
    ? `rotate(${-it.rotate} ${it.x + width / 2} ${base - it.size * 0.35})`
    : undefined;
  const testId =
    it.tag === 'watermark' && it.text === 'CANCELLED'
      ? 'preview-cancelled'
      : it.tag
        ? TEST_ID[it.tag]
        : undefined;
  return (
    <text
      x={it.x}
      y={base}
      fontSize={it.size}
      fontWeight={it.weight === 'bold' ? 700 : 400}
      fill={it.color}
      opacity={it.opacity}
      transform={transform}
      data-tag={it.tag}
      data-testid={testId}
      style={{ whiteSpace: 'pre' } as CSSProperties}
    >
      {runs.map((r, i) => (
        <tspan key={i} fontFamily={`'${cssFamily(r.family as FontFamily)}', sans-serif`}>
          {r.text}
        </tspan>
      ))}
    </text>
  );
}

function ItemDraw({ it, m, ascent }: { it: Item; m: TextMeasurer; ascent: number }) {
  switch (it.t) {
    case 'rect':
      return (
        <rect
          x={it.x}
          y={it.y}
          width={it.w}
          height={it.h}
          fill={it.fill ?? 'none'}
          stroke={it.stroke}
          strokeWidth={it.sw}
        />
      );
    case 'line':
      return (
        <line x1={it.x1} y1={it.y1} x2={it.x2} y2={it.y2} stroke={it.stroke} strokeWidth={it.sw} />
      );
    case 'qr':
      return <QrDraw it={it} />;
    case 'image':
      return (
        <image
          href={it.dataUrl}
          x={it.x}
          y={it.y}
          width={it.w}
          height={it.h}
          data-testid="preview-logo"
        />
      );
    case 'text':
      return <TextDraw it={it} m={m} ascent={ascent} />;
  }
}

/** A page's content as a string: pages that did not change between two layouts are not redrawn. */
function signature(page: LayoutPage): string {
  let out = `${page.width}x${page.height}:${page.items.length}`;
  for (const it of page.items) {
    switch (it.t) {
      case 'text':
        out += `|t${it.x.toFixed(1)},${it.y.toFixed(1)},${it.size},${it.weight},${it.color},${it.rotate ?? ''},${it.tag ?? ''},${it.text}`;
        break;
      case 'rect':
        out += `|r${it.x.toFixed(1)},${it.y.toFixed(1)},${it.w.toFixed(1)},${it.h.toFixed(1)},${it.fill ?? ''},${it.stroke ?? ''}`;
        break;
      case 'line':
        out += `|l${it.x1.toFixed(1)},${it.y1.toFixed(1)},${it.x2.toFixed(1)},${it.y2.toFixed(1)},${it.stroke}`;
        break;
      case 'qr':
        out += `|q${it.x.toFixed(1)},${it.y.toFixed(1)},${it.size},${it.data}`;
        break;
      case 'image':
        out += `|i${it.x.toFixed(1)},${it.y.toFixed(1)},${it.w},${it.h}`;
        break;
    }
  }
  return out;
}

const PageSvg = memo(
  function PageSvg({
    page,
    zoom,
    m,
    ascent,
  }: {
    page: LayoutPage;
    /** Only here so the comparator below can tell an unchanged page from a changed one. */
    sig: string;
    zoom: number;
    m: TextMeasurer;
    ascent: number;
  }) {
    const gs = useMemo(() => groups(page.items), [page.items]);
    return (
      <svg
        className="print-page mb-3 block bg-white shadow-sm"
        viewBox={`0 0 ${page.width} ${page.height}`}
        width={page.width * PX * (zoom / 100)}
        height={page.height * PX * (zoom / 100)}
        style={{ '--pw': `${page.width}pt`, '--ph': `${page.height}pt` } as CSSProperties}
        data-testid="preview-page"
        role="img"
      >
        <rect x={0} y={0} width={page.width} height={page.height} fill="#fff" />
        {gs.map((g, i) => {
          const inner = g.items.map((it, n) => <ItemDraw key={n} it={it} m={m} ascent={ascent} />);
          if (g.kind === 'line')
            return (
              <g key={i} data-testid="preview-line" data-line={g.key!.split(':')[1]}>
                {inner}
              </g>
            );
          if (g.kind === 'notes' || g.kind === 'terms')
            return (
              <g key={i} data-testid={`preview-${g.kind}`}>
                {inner}
              </g>
            );
          return <Fragment key={i}>{inner}</Fragment>;
        })}
      </svg>
    );
  },
  (a, b) => a.sig === b.sig && a.zoom === b.zoom && a.m === b.m && a.ascent === b.ascent,
);

/**
 * The document as it will print: the layout engine's pages drawn as SVG with the same fonts the PDF
 * embeds. `id="print-area"` is what the print stylesheet shows, one sheet per page.
 */
export function PageView({
  pages,
  zoom,
  measurer,
  paper,
}: {
  pages: readonly LayoutPage[];
  zoom: number;
  measurer: TextMeasurer;
  paper: string;
}) {
  const ascent = measurer.metrics().ascent;
  const sigs = useMemo(() => pages.map(signature), [pages]);
  return (
    <div id="print-area" data-testid="preview-sheet" data-paper={paper} data-pages={pages.length}>
      {pages.map((p, i) => (
        <PageSvg key={i} page={p} sig={sigs[i]!} zoom={zoom} m={measurer} ascent={ascent} />
      ))}
    </div>
  );
}
