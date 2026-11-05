/* eslint-disable jsx-a11y/no-noninteractive-element-interactions, jsx-a11y/no-noninteractive-tabindex --
   the resizer follows the WAI-ARIA window splitter pattern: a focusable separator operated by keyboard and pointer */
import { Button, TracePanel } from '@gst/ui';
import { PanelRightClose, PanelRightOpen } from '@gst/ui/icons';
import { createContext, useContext, useRef, useState } from 'react';
import type { KeyboardEvent, PointerEvent, ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { useAppStore } from '../store';

const MIN = 240;
const MAX = 640;

interface PanelValue {
  content: ReactNode;
  setContent: (node: ReactNode) => void;
}

const PanelContext = createContext<PanelValue>({ content: null, setContent: () => {} });

/** Detail and trace views put their content in the Books right panel through this hook. */
export const useRightPanel = () => useContext(PanelContext);

export function RightPanelProvider({ children }: { children: ReactNode }) {
  const [content, setContent] = useState<ReactNode>(null);
  return <PanelContext.Provider value={{ content, setContent }}>{children}</PanelContext.Provider>;
}

/** Resizable (drag or arrow keys) details panel on the right of the Books layout. */
export function RightPanel() {
  const { t } = useTranslation();
  const width = useAppStore((s) => s.panelWidth);
  const setWidth = useAppStore((s) => s.setPanelWidth);
  const { content } = useRightPanel();
  const [open, setOpen] = useState(true);
  const drag = useRef<{ x: number; w: number } | null>(null);
  const clamp = (w: number) => Math.min(MAX, Math.max(MIN, Math.round(w)));

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    drag.current = { x: e.clientX, w: width };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (drag.current) setWidth(clamp(drag.current.w + (drag.current.x - e.clientX)));
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'ArrowLeft') setWidth(clamp(width + 16));
    else if (e.key === 'ArrowRight') setWidth(clamp(width - 16));
    else if (e.key === 'Home') setWidth(MIN);
    else if (e.key === 'End') setWidth(MAX);
    else return;
    e.preventDefault();
  };

  if (!open) {
    return (
      <div className="border-l border-border p-1">
        <Button variant="ghost" aria-label={t('actions.openPanel')} onClick={() => setOpen(true)}>
          <PanelRightOpen size={16} aria-hidden />
        </Button>
      </div>
    );
  }
  return (
    <>
      {/* WAI-ARIA window splitter: a focusable separator that is operated with the keyboard */}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label={t('actions.resizePanel')}
        aria-valuemin={MIN}
        aria-valuemax={MAX}
        aria-valuenow={width}
        tabIndex={0}
        data-testid="panel-resizer"
        className="w-1 cursor-col-resize bg-border hover:bg-accent focus-visible:bg-accent"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={() => (drag.current = null)}
        onKeyDown={onKeyDown}
      />
      <aside
        aria-label={t('actions.panelTitle')}
        data-testid="right-panel"
        style={{ width }}
        className="flex shrink-0 flex-col gap-2 overflow-auto bg-bg p-3"
      >
        <div className="flex justify-end">
          <Button
            variant="ghost"
            aria-label={t('actions.closePanel')}
            onClick={() => setOpen(false)}
          >
            <PanelRightClose size={16} aria-hidden />
          </Button>
        </div>
        <TracePanel title={t('actions.panelTitle')}>{content}</TracePanel>
      </aside>
    </>
  );
}
