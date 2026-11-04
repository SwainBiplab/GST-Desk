import '@glideapps/glide-data-grid/dist/index.css';
import {
  DataEditor,
  type DataEditorProps,
  type DataEditorRef,
  type Theme,
} from '@glideapps/glide-data-grid';
import { useVirtualizer } from '@tanstack/react-virtual';
import * as React from 'react';

/** Read design tokens at render time so Glide's canvas follows light/dark and density. */
function readTheme(): Partial<Theme> {
  const cs = getComputedStyle(document.documentElement);
  const v = (name: string) => cs.getPropertyValue(name).trim();
  return {
    bgCell: v('--color-bg'),
    bgHeader: v('--color-surface-2'),
    bgHeaderHovered: v('--color-surface-3'),
    textDark: v('--color-fg'),
    textHeader: v('--color-fg-muted'),
    borderColor: v('--color-border'),
    accentColor: v('--color-accent'),
    accentFg: v('--color-accent-fg'),
    accentLight: v('--color-surface-2'),
    fontFamily: v('--font-sans'),
    baseFontStyle: '13px',
    headerFontStyle: '600 13px',
  };
}

export {
  CompactSelection,
  GridCellKind,
  type CellClickedEventArgs,
  type DataEditorRef,
  type EditableGridCell,
  type GridCell,
  type GridColumn,
  type GridKeyEventArgs,
  type GridSelection,
  type Item,
  type Theme,
} from '@glideapps/glide-data-grid';

export type DataGridProps = Omit<DataEditorProps, 'theme'>;

/** Glide Data Grid with theme bridging. Row height follows `--row-h`. */
export const DataGrid = React.forwardRef<DataEditorRef, DataGridProps>(
  function DataGrid(props, ref) {
    const [theme, setTheme] = React.useState<Partial<Theme>>(() => readTheme());
    const [rowHeight, setRowHeight] = React.useState(32);

    React.useEffect(() => {
      const sync = () => {
        setTheme(readTheme());
        const rem = parseFloat(
          getComputedStyle(document.documentElement).getPropertyValue('--row-h'),
        );
        if (!Number.isNaN(rem)) setRowHeight(Math.round(rem * 16));
      };
      sync();
      const obs = new MutationObserver(sync);
      obs.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ['data-theme', 'data-density', 'lang'],
      });
      return () => obs.disconnect();
    }, []);

    return <DataEditor ref={ref} rowHeight={rowHeight} theme={theme} {...props} />;
  },
);

export interface VirtualListProps<T> {
  items: readonly T[];
  estimateSize?: number;
  height?: number | string;
  renderItem: (item: T, index: number) => React.ReactNode;
  getKey?: (item: T, index: number) => React.Key;
}

/** Windowed list over TanStack Virtual. */
export function VirtualList<T>({
  items,
  estimateSize = 32,
  height = 400,
  renderItem,
  getKey,
}: VirtualListProps<T>) {
  const parentRef = React.useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => estimateSize,
    overscan: 8,
  });
  return (
    <div ref={parentRef} style={{ height, overflow: 'auto' }}>
      <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
        {virtualizer.getVirtualItems().map((row) => {
          const item = items[row.index] as T;
          return (
            <div
              key={getKey ? getKey(item, row.index) : row.key}
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                width: '100%',
                height: row.size,
                transform: `translateY(${row.start}px)`,
              }}
            >
              {renderItem(item, row.index)}
            </div>
          );
        })}
      </div>
    </div>
  );
}
