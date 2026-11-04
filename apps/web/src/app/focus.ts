/**
 * Dialogs opened from the keyboard or from code have no trigger element, so Radix has nowhere to
 * return focus to. Remember what had focus when we opened one and put it back on close.
 */
let remembered: HTMLElement | null = null;

export function rememberFocus(): void {
  const el = document.activeElement;
  remembered = el instanceof HTMLElement && el !== document.body ? el : null;
}

/** Use as `onCloseAutoFocus` on a dialog's content. */
export function restoreFocus(event: Event): void {
  if (!remembered) return;
  event.preventDefault();
  const el = remembered;
  remembered = null;
  if (el.isConnected) el.focus();
}
