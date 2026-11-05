import type { Row } from '@gst/db';
import { isBlankLine, type BuiltDocument, type DraftDocument, type DraftIssue } from '@gst/domain';
import {
  Button,
  CompactSelection,
  DataGrid,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  GridCellKind,
  toast,
  type DataEditorRef,
  type EditableGridCell,
  type GridCell,
  type GridColumn as GlideColumn,
  type GridSelection,
  type Item,
} from '@gst/ui';
import { Columns3 } from '@gst/ui/icons';
import {
  forwardRef,
  memo,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useTranslation } from 'react-i18next';

import {
  EDITABLE,
  GRID_COLUMNS,
  cellText,
  moveLine,
  pasteBlock,
  removeLines,
  sameIssues,
  setCell,
  updateLine,
  type GridColumn,
} from './state';

const WIDTH: Record<GridColumn, number> = {
  item: 260,
  hsn: 90,
  qty: 80,
  unit: 70,
  rate: 100,
  incl: 64,
  discount: 90,
  taxable: 110,
  taxRate: 76,
  tax: 100,
  total: 120,
  note: 180,
};
const NUMERIC: ReadonlySet<GridColumn> = new Set([
  'qty',
  'rate',
  'discount',
  'taxable',
  'taxRate',
  'tax',
  'total',
]);
const COMPUTED: ReadonlySet<GridColumn> = new Set(['taxable', 'tax', 'total']);

export interface LineGridHandle {
  /** Put the cursor on a cell and give the grid the keyboard. */
  select: (col: GridColumn, row: number) => void;
}

const cssVar = (name: string) =>
  getComputedStyle(document.documentElement).getPropertyValue(name).trim();

/**
 * The line items as a spreadsheet. Tab and arrows move, typing edits, Enter on an item cell opens the
 * item picker, paste takes a block from a spreadsheet, rows drag to reorder. Computed cells (taxable,
 * tax, total) are read-only and open the trace when clicked. Every number comes from the engine.
 */
const LineGridInner = forwardRef<
  LineGridHandle,
  {
    draft: DraftDocument;
    built: BuiltDocument;
    issues: DraftIssue[];
    units: Row[];
    hidden: ReadonlySet<GridColumn>;
    readOnly: boolean;
    onChange: (f: (d: DraftDocument) => DraftDocument) => void;
    onPickItem: (row: number, typed?: string) => void;
    onTrace: (lineKey: string) => void;
    onToggleColumn: (col: GridColumn) => void;
  }
>(function LineGrid(
  { draft, built, issues, units, hidden, readOnly, onChange, onPickItem, onTrace, onToggleColumn },
  ref,
) {
  const { t } = useTranslation();
  const grid = useRef<DataEditorRef>(null);
  // the parent's handlers change every render; the grid reads the latest through this, so it can skip
  // redrawing while its own data stays the same
  const handlers = useRef({ onChange, onPickItem, onTrace, onToggleColumn });
  useEffect(() => {
    handlers.current = { onChange, onPickItem, onTrace, onToggleColumn };
  });
  const [selection, setSelection] = useState<GridSelection>({
    columns: CompactSelection.empty(),
    rows: CompactSelection.empty(),
  });

  const visible = useMemo(() => GRID_COLUMNS.filter((c) => !hidden.has(c)), [hidden]);
  const columns = useMemo<GlideColumn[]>(
    () =>
      visible.map((c) => ({
        id: c,
        title:
          c === 'discount' ? t(`docs.grid.discount_${draft.discountMode}`) : t(`docs.grid.${c}`),
        width: WIDTH[c],
      })),
    [visible, t, draft.discountMode],
  );

  const unitCodes = useMemo(
    () => new Map(units.map((u) => [u['id'] as string, u['code'] as string])),
    [units],
  );
  const unitsByCode = useMemo(
    () => new Map(units.map((u) => [String(u['code']).toUpperCase(), u['id'] as string])),
    [units],
  );
  const builtByKey = useMemo(() => new Map(built.lines.map((l) => [l.key, l])), [built]);
  const issueRows = useMemo(
    () => new Set(issues.filter((i) => i.line !== undefined).map((i) => i.line!)),
    [issues],
  );

  const muted = useMemo(
    () => ({ textDark: cssVar('--color-fg-muted'), bgCell: cssVar('--color-surface-1') }),
    [],
  );

  useImperativeHandle(
    ref,
    () => ({
      select: (col, row) => {
        const x = visible.indexOf(col);
        if (x < 0) return;
        setSelection({
          columns: CompactSelection.empty(),
          rows: CompactSelection.empty(),
          current: { cell: [x, row], range: { x, y: row, width: 1, height: 1 }, rangeStack: [] },
        });
        grid.current?.scrollTo(x, row);
        grid.current?.focus();
      },
    }),
    [visible],
  );

  // Glide cancels an open cell editor when the cell it is editing comes back as a different object, so a
  // cell that has not changed must come back as the very same object, however often we re-render.
  const cells = useRef(new Map<string, { sig: string; cell: GridCell }>());

  const getCellContent = useCallback(
    ([c, r]: Item): GridCell => {
      const col = visible[c]!;
      const line = draft.lines[r];
      if (!line) return { kind: GridCellKind.Text, data: '', displayData: '', allowOverlay: false };
      const cached = (sig: string, make: () => GridCell): GridCell => {
        const key = `${line.key}:${col}`;
        const hit = cells.current.get(key);
        if (hit && hit.sig === sig) return hit.cell;
        const cell = make();
        cells.current.set(key, { sig, cell });
        return cell;
      };
      if (col === 'incl') {
        const readonly = readOnly || isBlankLine(line);
        return cached(`b|${line.inclusive}|${readonly}`, () => ({
          kind: GridCellKind.Boolean,
          data: line.inclusive,
          allowOverlay: false,
          readonly,
        }));
      }
      const text = cellText(line, col, {
        units: unitCodes,
        discountMode: draft.discountMode,
        built: builtByKey.get(line.key),
      });
      // the item column is picked from a list, not typed into: Enter, a double click or a letter opens it
      const editable =
        EDITABLE.has(col) &&
        col !== 'item' &&
        !readOnly &&
        !(col === 'discount' && draft.discountMode === 'none');
      return cached(`t|${text}|${editable}`, () => ({
        kind: GridCellKind.Text,
        data: text,
        displayData: text,
        allowOverlay: editable,
        readonly: !editable && col !== 'item',
        contentAlign: NUMERIC.has(col) ? 'right' : 'left',
        ...(COMPUTED.has(col) ? { themeOverride: muted } : {}),
      }));
    },
    [visible, draft.lines, draft.discountMode, unitCodes, builtByKey, readOnly, muted],
  );

  const onCellEdited = useCallback(
    ([c, r]: Item, value: EditableGridCell) => {
      const col = visible[c];
      const line = draft.lines[r];
      if (!col || !line || readOnly) return;
      const text =
        value.kind === GridCellKind.Boolean
          ? value.data
            ? 'yes'
            : ''
          : value.kind === GridCellKind.Text
            ? value.data
            : '';
      const out = setCell(line, col, text, { discountMode: draft.discountMode, unitsByCode });
      if (out.error) {
        toast.error(t(`docs.grid.bad.${out.error}`));
        return;
      }
      handlers.current.onChange((d) => updateLine(d, line.key, () => out.line));
    },
    [visible, draft.lines, draft.discountMode, unitsByCode, readOnly, t],
  );

  const onPaste = useCallback(
    (target: Item, values: readonly (readonly string[])[]): boolean => {
      if (readOnly) return false;
      const [c, r] = target;
      const result = pasteBlock(draft, visible, c, r, values, unitsByCode);
      handlers.current.onChange(() => result.draft);
      if (result.rejected.length > 0)
        toast.error(t('docs.grid.pasteRejected', { count: result.rejected.length }));
      return false;
    },
    [draft, visible, unitsByCode, readOnly, t],
  );

  const selectedKeys = useMemo(
    () =>
      new Set(
        selection.rows.toArray().flatMap((i) => (draft.lines[i] ? [draft.lines[i]!.key] : [])),
      ),
    [selection.rows, draft.lines],
  );

  // Enter, Space or a letter on an item cell opens the picker. Listening on the window (not on Glide's
  // canvas) keeps this working whichever element holds the focus after a click or after a dialog closes.
  const frame = useRef<HTMLDivElement>(null);
  const itemKey = useRef<(e: KeyboardEvent) => void>(() => {});
  useEffect(() => {
    itemKey.current = (e) => {
      const cell = selection.current?.cell;
      if (!cell || readOnly || visible[cell[0]] !== 'item') return;
      if (e.ctrlKey || e.metaKey || e.altKey || e.defaultPrevented) return;
      if (document.querySelector('[role="dialog"], [role="alertdialog"], [role="listbox"]')) return;
      const focus = document.activeElement;
      const inside = focus === document.body || (focus !== null && frame.current?.contains(focus));
      if (!inside) return;
      const typed = e.key.length === 1 && e.key !== ' ';
      if (e.key !== 'Enter' && !typed) return;
      e.preventDefault();
      e.stopPropagation();
      handlers.current.onPickItem(cell[1], typed ? e.key : undefined);
    };
  });
  useEffect(() => {
    const handle = (e: KeyboardEvent) => itemKey.current(e);
    window.addEventListener('keydown', handle, true);
    return () => window.removeEventListener('keydown', handle, true);
  }, []);

  const rows = draft.lines.length;
  const height = Math.min(Math.max(rows, 4), 12) * 32 + 40;

  return (
    <div className="flex flex-col gap-2" data-testid="line-grid">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs text-fg-muted">{t('docs.grid.help')}</p>
        <div className="flex items-center gap-1">
          {selectedKeys.size > 0 && !readOnly && (
            <Button
              variant="outline"
              data-testid="grid-remove"
              onClick={() => {
                handlers.current.onChange((d) => removeLines(d, selectedKeys));
                setSelection({ columns: CompactSelection.empty(), rows: CompactSelection.empty() });
              }}
            >
              {t('docs.grid.remove', { count: selectedKeys.size })}
            </Button>
          )}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                data-testid="grid-columns"
                aria-label={t('docs.grid.columns')}
              >
                <Columns3 size={14} aria-hidden /> {t('docs.grid.columns')}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {GRID_COLUMNS.filter((c) => c !== 'item').map((c) => (
                <DropdownMenuItem
                  key={c}
                  data-testid={`grid-col-${c}`}
                  onSelect={(e) => {
                    e.preventDefault();
                    handlers.current.onToggleColumn(c);
                  }}
                >
                  <span className="w-4">{hidden.has(c) ? '' : '✓'}</span> {t(`docs.grid.${c}`)}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
      <div ref={frame} style={{ height }} data-testid="grid-frame">
        <DataGrid
          ref={grid}
          columns={columns}
          rows={rows}
          getCellContent={getCellContent}
          onCellEdited={onCellEdited}
          gridSelection={selection}
          onGridSelectionChange={setSelection}
          onPaste={onPaste}
          onCellActivated={([c, r]) => {
            // a double click (Enter and Space are handled above, before Glide sees them)
            if (!readOnly && visible[c] === 'item') handlers.current.onPickItem(r);
          }}
          onFinishedEditing={(value, movement) => {
            // Enter after a quantity goes to the next line's item, ready to pick the next item
            const cell = selection.current?.cell;
            if (
              value &&
              cell &&
              movement[1] === 1 &&
              movement[0] === 0 &&
              visible[cell[0]] === 'qty'
            ) {
              const row = cell[1] + 1;
              requestAnimationFrame(() => {
                const x = visible.indexOf('item');
                setSelection({
                  columns: CompactSelection.empty(),
                  rows: CompactSelection.empty(),
                  current: {
                    cell: [x, row],
                    range: { x, y: row, width: 1, height: 1 },
                    rangeStack: [],
                  },
                });
              });
            }
          }}
          onCellClicked={([c, r]) => {
            const col = visible[c];
            const line = draft.lines[r];
            if (col && COMPUTED.has(col) && line && !isBlankLine(line))
              handlers.current.onTrace(line.key);
          }}
          onRowMoved={(from, to) =>
            !readOnly && handlers.current.onChange((d) => moveLine(d, from, to))
          }
          getRowThemeOverride={(r) =>
            issueRows.has(r) ? { textDark: cssVar('--color-danger') } : undefined
          }
          onDelete={(sel) => {
            if (readOnly) return false;
            if (sel.rows.length > 0) {
              const keys = new Set(
                sel.rows.toArray().flatMap((i) => (draft.lines[i] ? [draft.lines[i]!.key] : [])),
              );
              handlers.current.onChange((d) => removeLines(d, keys));
              return false;
            }
            return true;
          }}
          rowMarkers="both"
          // a single click only selects; opening the picker takes a double click (or Enter)
          cellActivationBehavior="double-click"
          freezeColumns={1}
          rowSelect="multi"
          smoothScrollX
          smoothScrollY
          width="100%"
          height="100%"
          getCellsForSelection
          keybindings={{ search: false }}
        />
      </div>
    </div>
  );
});

/** Redraws only when its data changes, not when the form around it does. */
export const LineGrid = memo(
  LineGridInner,
  (a, b) =>
    a.draft.lines === b.draft.lines &&
    a.draft.discountMode === b.draft.discountMode &&
    a.built === b.built &&
    sameIssues(a.issues, b.issues) &&
    a.units === b.units &&
    a.hidden === b.hidden &&
    a.readOnly === b.readOnly,
);
