import { cva } from 'class-variance-authority';
import { X } from 'lucide-react';
import {
  AlertDialog as AlertPrimitive,
  ContextMenu as ContextPrimitive,
  DropdownMenu as DropdownPrimitive,
  Dialog as DialogPrimitive,
  Popover as PopoverPrimitive,
  Tooltip as TooltipPrimitive,
} from 'radix-ui';
import * as React from 'react';

import { cn } from '../lib/cn';

import { Button, focusRing } from './primitives';

const overlayClass = 'fixed inset-0 z-(--z-overlay) bg-black/50';
const panelClass = 'rounded-lg border border-border bg-surface-1 p-4 text-fg shadow-lg';

/* ---------- Dialog ---------- */
export const Dialog = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogClose = DialogPrimitive.Close;
export const DialogTitle = DialogPrimitive.Title;
export const DialogDescription = DialogPrimitive.Description;

export const DialogContent = React.forwardRef<
  HTMLDivElement,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content>
>(({ className, children, ...props }, ref) => (
  <DialogPrimitive.Portal>
    <DialogPrimitive.Overlay className={overlayClass} />
    <DialogPrimitive.Content
      ref={ref}
      className={cn(
        panelClass,
        'fixed left-1/2 top-1/2 z-(--z-modal) w-[min(32rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2',
        className,
      )}
      {...props}
    >
      {children}
      <DialogPrimitive.Close
        aria-label="Close"
        className={cn('absolute right-3 top-3 rounded-sm p-1 hover:bg-surface-2', focusRing)}
      >
        <X size={16} aria-hidden />
      </DialogPrimitive.Close>
    </DialogPrimitive.Content>
  </DialogPrimitive.Portal>
));
DialogContent.displayName = 'DialogContent';

/* ---------- Alert dialog (confirm) ---------- */
export const AlertDialog = AlertPrimitive.Root;
export const AlertDialogTrigger = AlertPrimitive.Trigger;
export const AlertDialogTitle = AlertPrimitive.Title;
export const AlertDialogDescription = AlertPrimitive.Description;

export function AlertDialogContent({
  className,
  children,
  ...props
}: React.ComponentPropsWithoutRef<typeof AlertPrimitive.Content>) {
  return (
    <AlertPrimitive.Portal>
      <AlertPrimitive.Overlay className={overlayClass} />
      <AlertPrimitive.Content
        className={cn(
          panelClass,
          'fixed left-1/2 top-1/2 z-(--z-modal) w-[min(28rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2',
          className,
        )}
        {...props}
      >
        {children}
      </AlertPrimitive.Content>
    </AlertPrimitive.Portal>
  );
}

export function AlertDialogCancel(
  props: React.ComponentPropsWithoutRef<typeof AlertPrimitive.Cancel>,
) {
  return (
    <AlertPrimitive.Cancel asChild>
      <Button variant="outline" {...props} />
    </AlertPrimitive.Cancel>
  );
}

export function AlertDialogAction(
  props: React.ComponentPropsWithoutRef<typeof AlertPrimitive.Action>,
) {
  return (
    <AlertPrimitive.Action asChild>
      <Button variant="danger" {...props} />
    </AlertPrimitive.Action>
  );
}

/* ---------- Sheet / Drawer (Dialog edge-anchored) ---------- */
const sheetVariants = cva(`${panelClass} fixed z-(--z-modal) rounded-none`, {
  variants: {
    side: {
      right: 'inset-y-0 right-0 w-[min(28rem,100vw)]',
      left: 'inset-y-0 left-0 w-[min(28rem,100vw)]',
      bottom: 'inset-x-0 bottom-0 max-h-[85vh] rounded-t-lg',
    },
  },
  defaultVariants: { side: 'right' },
});

export const Sheet = DialogPrimitive.Root;
export const SheetTrigger = DialogPrimitive.Trigger;
export const SheetTitle = DialogPrimitive.Title;
export const SheetDescription = DialogPrimitive.Description;

export function SheetContent({
  side,
  className,
  children,
  ...props
}: React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content> & {
  side?: 'right' | 'left' | 'bottom';
}) {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className={overlayClass} />
      <DialogPrimitive.Content className={cn(sheetVariants({ side }), className)} {...props}>
        {children}
        <DialogPrimitive.Close
          aria-label="Close"
          className={cn('absolute right-3 top-3 rounded-sm p-1 hover:bg-surface-2', focusRing)}
        >
          <X size={16} aria-hidden />
        </DialogPrimitive.Close>
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}

/** Drawer = bottom sheet (touch-first surfaces). */
export function DrawerContent(
  props: React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content>,
) {
  return <SheetContent side="bottom" {...props} />;
}
export const Drawer = Sheet;
export const DrawerTrigger = SheetTrigger;

/* ---------- Menus ---------- */
const menuClass =
  'z-(--z-dropdown) min-w-40 rounded-md border border-border bg-surface-1 p-1 text-sm text-fg shadow-md';
const menuItemClass =
  'flex h-(--control-h) cursor-default select-none items-center rounded-sm px-2 outline-none data-highlighted:bg-surface-2 data-disabled:opacity-50';

export const DropdownMenu = DropdownPrimitive.Root;
export const DropdownMenuTrigger = DropdownPrimitive.Trigger;

export function DropdownMenuContent({
  className,
  ...props
}: React.ComponentPropsWithoutRef<typeof DropdownPrimitive.Content>) {
  return (
    <DropdownPrimitive.Portal>
      <DropdownPrimitive.Content sideOffset={4} className={cn(menuClass, className)} {...props} />
    </DropdownPrimitive.Portal>
  );
}

export function DropdownMenuItem({
  className,
  ...props
}: React.ComponentPropsWithoutRef<typeof DropdownPrimitive.Item>) {
  return <DropdownPrimitive.Item className={cn(menuItemClass, className)} {...props} />;
}

export const ContextMenu = ContextPrimitive.Root;
export const ContextMenuTrigger = ContextPrimitive.Trigger;

export function ContextMenuContent({
  className,
  ...props
}: React.ComponentPropsWithoutRef<typeof ContextPrimitive.Content>) {
  return (
    <ContextPrimitive.Portal>
      <ContextPrimitive.Content className={cn(menuClass, className)} {...props} />
    </ContextPrimitive.Portal>
  );
}

export function ContextMenuItem({
  className,
  ...props
}: React.ComponentPropsWithoutRef<typeof ContextPrimitive.Item>) {
  return <ContextPrimitive.Item className={cn(menuItemClass, className)} {...props} />;
}

/* ---------- Tooltip / Popover ---------- */
export const TooltipProvider = TooltipPrimitive.Provider;
export const Tooltip = TooltipPrimitive.Root;
export const TooltipTrigger = TooltipPrimitive.Trigger;

export function TooltipContent({
  className,
  ...props
}: React.ComponentPropsWithoutRef<typeof TooltipPrimitive.Content>) {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Content
        sideOffset={4}
        className={cn(
          'z-(--z-toast) rounded-md bg-fg px-2 py-1 text-xs text-bg shadow-md',
          className,
        )}
        {...props}
      />
    </TooltipPrimitive.Portal>
  );
}

export const Popover = PopoverPrimitive.Root;
export const PopoverTrigger = PopoverPrimitive.Trigger;
export const PopoverAnchor = PopoverPrimitive.Anchor;

export const PopoverContent = React.forwardRef<
  HTMLDivElement,
  React.ComponentPropsWithoutRef<typeof PopoverPrimitive.Content>
>(({ className, ...props }, ref) => (
  <PopoverPrimitive.Portal>
    <PopoverPrimitive.Content
      ref={ref}
      sideOffset={4}
      className={cn(panelClass, 'z-(--z-dropdown) p-3', className)}
      {...props}
    />
  </PopoverPrimitive.Portal>
));
PopoverContent.displayName = 'PopoverContent';
