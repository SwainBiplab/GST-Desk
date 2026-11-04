/**
 * The dashboard charts: grouped columns, lines and a ranked bar list, drawn as SVG with no chart
 * library. Specs follow the data-viz rules: one axis, marks thin (bars at most 24 px, lines 2 px, dots
 * 8 px with a surface ring), 4 px rounded data-ends on a flat baseline, a 2 px gap between touching
 * bars, hairline grid, text in text tokens (the series colour rides on the mark beside it), a legend
 * for two or more series, a hover tooltip, and a table view of the same numbers.
 */
import { formatPaise, Card, CardTitle } from '@gst/ui';
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

export interface Series {
  key: string;
  label: string;
  /** A CSS variable from `.viz` (`--viz-1`). */
  color: string;
}

export interface Group {
  /** Shown under the mark. */
  label: string;
  /** Shown in the tooltip and the table. */
  title: string;
  values: Record<string, number>;
}

/* ------------------------------------------------------------------ numbers */

/** Rupees in the short Indian style an axis can carry: 45K, 1.2L, 3.4Cr. `paise` in, text out. */
export function compactInr(paise: number): string {
  const r = Math.abs(paise) / 100;
  const sign = paise < 0 ? '-' : '';
  const trim = (x: number) => x.toFixed(x >= 100 ? 0 : 1).replace(/\.0$/, '');
  if (r >= 1e7) return `${sign}₹${trim(r / 1e7)}Cr`;
  if (r >= 1e5) return `${sign}₹${trim(r / 1e5)}L`;
  if (r >= 1e3) return `${sign}₹${trim(r / 1e3)}K`;
  return `${sign}₹${Math.round(r)}`;
}

/** Axis ticks on round numbers covering `min`..`max` (paise): about `count` steps of 1, 2, 2.5 or 5 times a power of ten. */
export function niceTicks(min: number, max: number, count = 4): number[] {
  const lo = Math.min(0, min);
  const hi = Math.max(0, max);
  if (hi === 0 && lo === 0) return [0, 100_00];
  const raw = (hi - lo) / count;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const step = ([1, 2, 2.5, 5, 10].map((m) => m * pow).find((s) => s >= raw) ?? raw) || 1;
  const out: number[] = [];
  for (let v = Math.floor(lo / step) * step; v < hi + step * 0.999; v += step)
    out.push(Math.round(v));
  return out;
}

/** The bar from `y0` to `y1` as a path: square at the baseline, `r` rounded at the data end. */
export function barPath(x: number, w: number, y0: number, y1: number, radius = 4): string {
  const h = Math.abs(y1 - y0);
  if (h < 0.5) return '';
  const r = Math.min(radius, w / 2, h);
  const up = y1 < y0;
  if (up) {
    return `M${x},${y0}V${y1 + r}a${r},${r} 0 0 1 ${r},${-r}H${x + w - r}a${r},${r} 0 0 1 ${r},${r}V${y0}Z`;
  }
  return `M${x},${y0}V${y1 - r}a${r},${r} 0 0 0 ${r},${r}H${x + w - r}a${r},${r} 0 0 0 ${r},${-r}V${y0}Z`;
}

/* ------------------------------------------------------------------ plumbing */

/** Width of an element, kept up to date as the layout changes. */
function useWidth(): [React.RefObject<HTMLDivElement | null>, number] {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(480);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(Math.max(240, Math.floor(el.getBoundingClientRect().width)));
    const ro = new ResizeObserver(([entry]) => {
      if (entry) setWidth(Math.max(240, Math.floor(entry.contentRect.width)));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width];
}

const HEIGHT = 208;
const PAD = { top: 12, right: 8, bottom: 26, left: 46 };

function Legend({ series }: { series: Series[] }) {
  if (series.length < 2) return null;
  return (
    <ul
      className="flex flex-wrap gap-x-4 gap-y-1 pb-1 text-xs text-fg-muted"
      data-testid="chart-legend"
    >
      {series.map((s) => (
        <li key={s.key} className="flex items-center gap-1.5">
          <span
            aria-hidden
            className="inline-block size-2.5 rounded-sm"
            style={{ background: `var(${s.color})` }}
          />
          {s.label}
        </li>
      ))}
    </ul>
  );
}

function Tooltip({
  x,
  width,
  group,
  series,
}: {
  x: number;
  width: number;
  group: Group;
  series: Series[];
}) {
  const left = Math.min(Math.max(x - 80, 0), Math.max(0, width - 168));
  return (
    <div
      role="status"
      data-testid="chart-tooltip"
      className="pointer-events-none absolute top-0 z-10 w-40 rounded-md border border-border bg-bg p-2 text-xs shadow-md"
      style={{ left }}
    >
      <p className="pb-1 font-semibold text-fg">{group.title}</p>
      {series.map((s) => (
        <p key={s.key} className="flex items-center justify-between gap-2 text-fg-muted">
          <span className="flex items-center gap-1.5">
            <span
              aria-hidden
              className="inline-block size-2 rounded-sm"
              style={{ background: `var(${s.color})` }}
            />
            {s.label}
          </span>
          <span className="tabular text-fg">{formatPaise(group.values[s.key] ?? 0)}</span>
        </p>
      ))}
    </div>
  );
}

/** The same numbers as a table, for anyone who would rather read them than see them. */
function DataTable({
  caption,
  groups,
  series,
  first,
}: {
  caption: string;
  groups: Group[];
  series: Series[];
  first: string;
}) {
  return (
    <table className="w-full text-sm" data-testid="chart-table">
      <caption className="sr-only">{caption}</caption>
      <thead>
        <tr className="text-left text-xs uppercase text-fg-muted">
          <th className="py-1 font-medium">{first}</th>
          {series.map((s) => (
            <th key={s.key} className="py-1 text-right font-medium">
              {s.label}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {groups.map((g) => (
          <tr key={g.title} className="border-t border-border">
            <td className="py-1">{g.title}</td>
            {series.map((s) => (
              <td key={s.key} className="tabular py-1 text-right">
                {formatPaise(g.values[s.key] ?? 0)}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** A card with a chart in it and a switch to the table of its numbers. */
export function ChartCard({
  testId,
  title,
  note,
  table,
  children,
}: {
  testId: string;
  title: string;
  note?: string | undefined;
  /** The table view; the card shows a switch only when there is one. */
  table?: ReactNode;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  const [asTable, setAsTable] = useState(false);
  return (
    <Card data-testid={testId} className="min-w-0">
      <div className="flex items-start justify-between gap-2">
        <CardTitle>{title}</CardTitle>
        {table && (
          <button
            type="button"
            data-testid={`${testId}-switch`}
            aria-pressed={asTable}
            onClick={() => setAsTable((v) => !v)}
            className="shrink-0 rounded px-1 text-xs text-fg-muted underline-offset-2 hover:underline"
          >
            {asTable ? t('dash.chart.showChart') : t('dash.chart.showTable')}
          </button>
        )}
      </div>
      {note && <p className="pt-1 text-xs text-fg-muted">{note}</p>}
      <div className="viz pt-2">{asTable && table ? table : children}</div>
    </Card>
  );
}

export { DataTable };

/* ------------------------------------------------------------------ columns */

export function ColumnChart({
  groups,
  series,
  caption,
  onSelect,
}: {
  groups: Group[];
  series: Series[];
  caption: string;
  /** A bar was chosen: the group's index and the series. */
  onSelect?: (index: number, series: string) => void;
}) {
  const [ref, width] = useWidth();
  const [hover, setHover] = useState<number | null>(null);
  const id = useId();
  const values = groups.flatMap((g) => series.map((s) => g.values[s.key] ?? 0));
  const ticks = niceTicks(Math.min(0, ...values), Math.max(0, ...values));
  const lo = ticks[0]!;
  const hi = ticks[ticks.length - 1]!;
  const plotW = width - PAD.left - PAD.right;
  const plotH = HEIGHT - PAD.top - PAD.bottom;
  const y = (v: number) => PAD.top + plotH - ((v - lo) / (hi - lo || 1)) * plotH;
  const band = plotW / Math.max(1, groups.length);
  const barW = Math.min(24, Math.max(4, (band - 10) / series.length - 2));
  const clusterW = series.length * barW + (series.length - 1) * 2;
  // label about every `skip` bands so labels never touch
  const skip = Math.max(1, Math.ceil(30 / band));

  return (
    <div ref={ref} className="relative" data-testid="chart-columns">
      <Legend series={series} />
      <svg width={width} height={HEIGHT} role="img" aria-label={caption} className="block">
        <title id={id}>{caption}</title>
        {ticks.map((tick) => (
          <g key={tick}>
            <line
              x1={PAD.left}
              x2={width - PAD.right}
              y1={y(tick)}
              y2={y(tick)}
              stroke="var(--color-border)"
              strokeWidth={1}
              opacity={tick === 0 ? 1 : 0.55}
            />
            <text
              x={PAD.left - 6}
              y={y(tick)}
              textAnchor="end"
              dominantBaseline="middle"
              fontSize={11}
              fill="var(--color-fg-muted)"
            >
              {compactInr(tick)}
            </text>
          </g>
        ))}
        {groups.map((g, i) => {
          const cx = PAD.left + band * i + band / 2;
          const x0 = cx - clusterW / 2;
          return (
            <g
              key={g.title}
              onPointerEnter={() => setHover(i)}
              onPointerLeave={() => setHover(null)}
            >
              {/* the whole column of the plot is the hit area, so a short bar is as easy to reach as a tall one */}
              <rect
                x={PAD.left + band * i}
                y={PAD.top}
                width={band}
                height={plotH}
                fill={hover === i ? 'var(--color-surface-2)' : 'transparent'}
                opacity={0.7}
              />
              {series.map((s, si) => {
                const v = g.values[s.key] ?? 0;
                const d = barPath(x0 + si * (barW + 2), barW, y(0), y(v));
                return d ? (
                  <path
                    key={s.key}
                    d={d}
                    fill={`var(${s.color})`}
                    data-testid={`bar-${s.key}`}
                    style={onSelect ? { cursor: 'pointer' } : undefined}
                    onClick={onSelect ? () => onSelect(i, s.key) : undefined}
                  />
                ) : null;
              })}
              {i % skip === 0 && (
                <text
                  x={cx}
                  y={HEIGHT - 8}
                  textAnchor="middle"
                  fontSize={11}
                  fill="var(--color-fg-muted)"
                >
                  {g.label}
                </text>
              )}
            </g>
          );
        })}
      </svg>
      {hover !== null && (
        <Tooltip
          x={PAD.left + band * hover + band / 2}
          width={width}
          group={groups[hover]!}
          series={series}
        />
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ lines */

export function LineChart({
  groups,
  series,
  caption,
}: {
  groups: Group[];
  series: Series[];
  caption: string;
}) {
  const [ref, width] = useWidth();
  const [hover, setHover] = useState<number | null>(null);
  const values = groups.flatMap((g) => series.map((s) => g.values[s.key] ?? 0));
  const ticks = niceTicks(Math.min(0, ...values), Math.max(0, ...values));
  const lo = ticks[0]!;
  const hi = ticks[ticks.length - 1]!;
  const plotW = width - PAD.left - PAD.right - 8;
  const plotH = HEIGHT - PAD.top - PAD.bottom;
  const y = (v: number) => PAD.top + plotH - ((v - lo) / (hi - lo || 1)) * plotH;
  const x = (i: number) =>
    PAD.left + 4 + (groups.length === 1 ? plotW / 2 : (plotW / (groups.length - 1)) * i);
  const path = (key: string) =>
    groups.map((g, i) => `${i === 0 ? 'M' : 'L'}${x(i)},${y(g.values[key] ?? 0)}`).join('');
  const nearest = (clientX: number, el: SVGSVGElement) => {
    const px = clientX - el.getBoundingClientRect().left;
    return Math.min(
      groups.length - 1,
      Math.max(0, Math.round(((px - PAD.left - 4) / (plotW || 1)) * (groups.length - 1))),
    );
  };

  return (
    <div ref={ref} className="relative" data-testid="chart-lines">
      <Legend series={series} />
      <svg
        width={width}
        height={HEIGHT}
        role="img"
        aria-label={caption}
        className="block"
        onPointerMove={(e) => setHover(nearest(e.clientX, e.currentTarget))}
        onPointerLeave={() => setHover(null)}
      >
        <title>{caption}</title>
        {ticks.map((tick) => (
          <g key={tick}>
            <line
              x1={PAD.left}
              x2={width - PAD.right}
              y1={y(tick)}
              y2={y(tick)}
              stroke="var(--color-border)"
              strokeWidth={1}
              opacity={tick === 0 ? 1 : 0.55}
            />
            <text
              x={PAD.left - 6}
              y={y(tick)}
              textAnchor="end"
              dominantBaseline="middle"
              fontSize={11}
              fill="var(--color-fg-muted)"
            >
              {compactInr(tick)}
            </text>
          </g>
        ))}
        {/* a wash under the first series, never a solid block */}
        {series[0] && groups.length > 1 && (
          <path
            d={`${path(series[0].key)}L${x(groups.length - 1)},${y(0)}L${x(0)},${y(0)}Z`}
            fill={`var(${series[0].color})`}
            opacity={0.1}
          />
        )}
        {groups.map((g, i) => (
          <text
            key={g.title}
            x={x(i)}
            y={HEIGHT - 8}
            textAnchor="middle"
            fontSize={11}
            fill="var(--color-fg-muted)"
          >
            {g.label}
          </text>
        ))}
        {hover !== null && (
          <line
            x1={x(hover)}
            x2={x(hover)}
            y1={PAD.top}
            y2={PAD.top + plotH}
            stroke="var(--color-border)"
            strokeWidth={1}
          />
        )}
        {series.map((s) => (
          <g key={s.key}>
            <path
              d={path(s.key)}
              fill="none"
              stroke={`var(${s.color})`}
              strokeWidth={2}
              strokeLinecap="round"
              strokeLinejoin="round"
              data-testid={`line-${s.key}`}
            />
            {/* the end of each line carries a dot with a surface ring; the hovered point gets one too */}
            {[
              groups.length - 1,
              ...(hover !== null && hover !== groups.length - 1 ? [hover] : []),
            ].map((i) => (
              <circle
                key={i}
                cx={x(i)}
                cy={y(groups[i]!.values[s.key] ?? 0)}
                r={4}
                fill={`var(${s.color})`}
                stroke="var(--color-bg)"
                strokeWidth={2}
              />
            ))}
          </g>
        ))}
      </svg>
      {hover !== null && (
        <Tooltip x={x(hover)} width={width} group={groups[hover]!} series={series} />
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ ranked bars */

export interface RankRow {
  key: string;
  label: string;
  paise: number;
  onOpen?: () => void;
}

/** Horizontal bars, largest first: the name, the bar, the value at its tip. One series, so no legend. */
export function BarList({
  rows,
  colorVar = '--viz-1',
  caption,
}: {
  rows: RankRow[];
  colorVar?: string;
  caption: string;
}) {
  const max = Math.max(1, ...rows.map((r) => r.paise));
  return (
    <ol className="viz flex flex-col gap-2" aria-label={caption} data-testid="chart-barlist">
      {rows.map((r) => (
        <li key={r.key}>
          <button
            type="button"
            onClick={r.onOpen}
            disabled={!r.onOpen}
            data-testid="chart-bar-row"
            className="grid w-full grid-cols-[minmax(0,9rem)_minmax(0,1fr)_auto] items-center gap-2 rounded text-left text-sm enabled:hover:bg-surface-1"
          >
            <span className="truncate">{r.label}</span>
            <span
              aria-hidden
              className="block h-3 rounded-r-[4px]"
              style={{
                width: `${Math.max(2, (r.paise / max) * 100)}%`,
                background: `var(${colorVar})`,
              }}
            />
            <span className="tabular text-xs text-fg-muted">{compactInr(r.paise)}</span>
          </button>
        </li>
      ))}
    </ol>
  );
}
