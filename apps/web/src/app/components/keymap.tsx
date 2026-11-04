import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  Table,
  TableBody,
  TableCell,
  TableRow,
} from '@gst/ui';
import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';

import { useActionContext } from '../action-context';
import { restoreFocus } from '../focus';
import { GO_TO, isTypingTarget, shortcutsFor } from '../shortcuts';
import { useAppStore } from '../store';

/** The in-app keyboard map (`?`). Content comes from the same list as docs/keyboard.md. */
export function KeymapDialog() {
  const { t } = useTranslation();
  const open = useAppStore((s) => s.keymapOpen);
  const setOpen = useAppStore((s) => s.setKeymapOpen);
  const { shell } = useActionContext();
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent data-testid="keymap" onCloseAutoFocus={restoreFocus}>
        <DialogTitle>{t('keymap.title')}</DialogTitle>
        <DialogDescription>{t('keymap.description')}</DialogDescription>
        <Table className="mt-3">
          <TableBody>
            {shortcutsFor(shell).map((s) => (
              <TableRow key={s.keys}>
                <TableCell>
                  <kbd className="rounded-sm border border-border px-1.5 text-xs">{s.keys}</kbd>
                </TableCell>
                <TableCell>{s.description}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </DialogContent>
    </Dialog>
  );
}

const dialogOpen = () => !!document.querySelector('[role="dialog"], [role="alertdialog"]');

/** Global shortcuts. Ignored while typing in a field or while a dialog is open (except Ctrl+K). */
export function Hotkeys() {
  const ctx = useActionContext();
  const setCommandOpen = useAppStore((s) => s.setCommandOpen);
  const setKeymapOpen = useAppStore((s) => s.setKeymapOpen);
  const ref = useRef(ctx);
  useEffect(() => {
    ref.current = ctx;
  });
  const pendingG = useRef(0);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const c = ref.current;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setCommandOpen(!useAppStore.getState().commandOpen);
        return;
      }
      if (e.ctrlKey || e.metaKey || e.altKey || isTypingTarget(e.target) || dialogOpen()) return;

      if (e.key === '/') {
        e.preventDefault();
        setCommandOpen(true);
      } else if (e.key === '?') {
        e.preventDefault();
        setKeymapOpen(true);
      } else if (c.shell === 'books') {
        const k = e.key.toLowerCase();
        if (pendingG.current && Date.now() - pendingG.current < 1200) {
          pendingG.current = 0;
          const target = GO_TO[k];
          if (target) {
            e.preventDefault();
            c.navigate(`/books/${target.page}`);
          }
        } else if (k === 'g') {
          pendingG.current = Date.now();
        } else if (k === 'n') {
          e.preventDefault();
          setCommandOpen(true, 'new ');
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [setCommandOpen, setKeymapOpen]);

  return null;
}
