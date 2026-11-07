/**
 * A list row that swipes sideways to reveal actions (prompt 43): drag left to see them, past the far
 * threshold the first one runs at once. Pointer events, so a mouse works too; keyboard users get the
 * same actions in the row's menu or buttons. Thresholds are in `logic.ts`.
 */
import { cn } from '@gst/ui';
import { useRef, useState, type PointerEvent, type ReactNode } from 'react';

import { SWIPE_COMMIT_PX, SWIPE_OPEN_PX, swipeOutcome } from './logic';

export interface SwipeAction {
  id: string;
  label: string;
  tone?: 'neutral' | 'danger' | 'accent';
  run: () => void;
}

export function SwipeRow({
  actions,
  children,
  className,
  testId,
}: {
  actions: SwipeAction[];
  children: ReactNode;
  className?: string;
  testId?: string;
}) {
  const [dx, setDx] = useState(0);
  const [open, setOpen] = useState(false);
  const start = useRef<{ x: number; y: number; id: number } | null>(null);
  const width = Math.min(actions.length * SWIPE_OPEN_PX, 3 * SWIPE_OPEN_PX);

  const onDown = (e: PointerEvent<HTMLDivElement>) => {
    if (actions.length === 0) return;
    start.current = { x: e.clientX, y: e.clientY, id: e.pointerId };
  };
  const onMove = (e: PointerEvent<HTMLDivElement>) => {
    if (!start.current || start.current.id !== e.pointerId) return;
    const ddx = e.clientX - start.current.x;
    const ddy = e.clientY - start.current.y;
    // a vertical drag is a scroll: leave it to the list
    if (Math.abs(ddy) > Math.abs(ddx) && Math.abs(ddx) < 10) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    // the row may travel past its actions, to where the first one runs on its own
    setDx(Math.max(-SWIPE_COMMIT_PX - 40, Math.min(open ? width : 0, ddx + (open ? -width : 0))));
  };
  const onUp = (e: PointerEvent<HTMLDivElement>) => {
    if (!start.current || start.current.id !== e.pointerId) return;
    start.current = null;
    const out = swipeOutcome(dx);
    if (out === 'commit' && dx < 0) {
      setDx(0);
      setOpen(false);
      actions[0]?.run();
      return;
    }
    const now = out === 'open' && dx < 0;
    setOpen(now);
    setDx(now ? -width : 0);
  };

  return (
    <div
      className={cn('relative overflow-hidden', className)}
      data-testid={testId}
      data-open={open}
    >
      <div className="absolute inset-y-0 right-0 flex" style={{ width }} aria-hidden={!open}>
        {actions.slice(0, 3).map((a) => (
          <button
            key={a.id}
            type="button"
            tabIndex={open ? 0 : -1}
            data-testid={`swipe-${a.id}`}
            onClick={() => {
              setOpen(false);
              setDx(0);
              a.run();
            }}
            className={cn(
              'flex flex-1 items-center justify-center px-2 text-xs font-medium',
              a.tone === 'danger'
                ? 'bg-danger text-danger-fg'
                : a.tone === 'accent'
                  ? 'bg-accent text-accent-fg'
                  : 'bg-surface-3 text-fg',
            )}
          >
            {a.label}
          </button>
        ))}
      </div>
      <div
        className="relative bg-bg transition-transform"
        style={{ transform: `translateX(${dx}px)`, touchAction: 'pan-y' }}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
      >
        {children}
      </div>
    </div>
  );
}
