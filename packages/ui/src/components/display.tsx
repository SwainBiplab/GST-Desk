import { cva, type VariantProps } from 'class-variance-authority';
import {
  ScrollArea as ScrollPrimitive,
  Separator as SeparatorPrimitive,
  Tabs as TabsPrimitive,
} from 'radix-ui';
import * as React from 'react';
import { Toaster as Sonner, toast } from 'sonner';

import { cn } from '../lib/cn';

import { focusRing } from './primitives';

/* ---------- Tabs ---------- */
export const Tabs = TabsPrimitive.Root;

export function TabsList({
  className,
  ...props
}: React.ComponentPropsWithoutRef<typeof TabsPrimitive.List>) {
  return (
    <TabsPrimitive.List
      className={cn('inline-flex gap-1 border-b border-border', className)}
      {...props}
    />
  );
}

export function TabsTrigger({
  className,
  ...props
}: React.ComponentPropsWithoutRef<typeof TabsPrimitive.Trigger>) {
  return (
    <TabsPrimitive.Trigger
      className={cn(
        `h-(--control-h) px-(--pad-x) text-sm text-fg-muted data-[state=active]:border-b-2 data-[state=active]:border-accent data-[state=active]:text-fg ${focusRing}`,
        className,
      )}
      {...props}
    />
  );
}

export function TabsContent({
  className,
  ...props
}: React.ComponentPropsWithoutRef<typeof TabsPrimitive.Content>) {
  return <TabsPrimitive.Content className={cn('pt-3', focusRing, className)} {...props} />;
}

/* ---------- Toast (sonner) ---------- */
export function Toaster(props: React.ComponentProps<typeof Sonner>) {
  return <Sonner style={{ zIndex: 'var(--z-toast)' } as React.CSSProperties} {...props} />;
}
export { toast };

/* ---------- Badge ---------- */
export const badgeVariants = cva(
  'inline-flex items-center rounded-sm px-1.5 py-0.5 text-xs font-medium',
  {
    variants: {
      tone: {
        neutral: 'bg-surface-3 text-fg',
        success: 'bg-success text-success-fg',
        warning: 'bg-warning text-warning-fg',
        danger: 'bg-danger text-danger-fg',
        info: 'bg-info text-info-fg',
        accent: 'bg-accent text-accent-fg',
      },
    },
    defaultVariants: { tone: 'neutral' },
  },
);

export function Badge({
  className,
  tone,
  ...props
}: React.HTMLAttributes<HTMLSpanElement> & VariantProps<typeof badgeVariants>) {
  return <span className={cn(badgeVariants({ tone }), className)} {...props} />;
}

/* ---------- Card ---------- */
export function Card({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn('rounded-lg border border-border bg-surface-1 p-4 shadow-sm', className)}
      {...props}
    />
  );
}
export function CardTitle({ className, ...props }: React.HTMLAttributes<HTMLHeadingElement>) {
  return <h3 className={cn('text-lg font-semibold', className)} {...props} />;
}

/* ---------- Table ---------- */
export function Table({ className, ...props }: React.TableHTMLAttributes<HTMLTableElement>) {
  return <table className={cn('w-full border-collapse text-sm', className)} {...props} />;
}
export function TableHead({ className, ...props }: React.HTMLAttributes<HTMLTableSectionElement>) {
  return <thead className={cn('bg-surface-2 text-left text-fg-muted', className)} {...props} />;
}
export function TableBody(props: React.HTMLAttributes<HTMLTableSectionElement>) {
  return <tbody {...props} />;
}
export function TableRow({ className, ...props }: React.HTMLAttributes<HTMLTableRowElement>) {
  return (
    <tr
      className={cn('h-(--row-h) border-b border-border hover:bg-surface-1', className)}
      {...props}
    />
  );
}
export function TableCell({ className, ...props }: React.TdHTMLAttributes<HTMLTableCellElement>) {
  return <td className={cn('px-(--pad-x)', className)} {...props} />;
}
export function TableHeaderCell({
  className,
  ...props
}: React.ThHTMLAttributes<HTMLTableCellElement>) {
  return <th className={cn('px-(--pad-x) font-medium', className)} {...props} />;
}

/* ---------- Skeleton / Separator / ScrollArea ---------- */
export function Skeleton({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      aria-hidden
      className={cn('animate-pulse rounded-md bg-surface-3', className)}
      {...props}
    />
  );
}

export function Separator({
  className,
  ...props
}: React.ComponentPropsWithoutRef<typeof SeparatorPrimitive.Root>) {
  return (
    <SeparatorPrimitive.Root
      className={cn(
        'bg-border data-[orientation=horizontal]:h-px data-[orientation=horizontal]:w-full data-[orientation=vertical]:w-px',
        className,
      )}
      {...props}
    />
  );
}

export function ScrollArea({
  className,
  children,
  ...props
}: React.ComponentPropsWithoutRef<typeof ScrollPrimitive.Root>) {
  return (
    <ScrollPrimitive.Root className={cn('overflow-hidden', className)} {...props}>
      <ScrollPrimitive.Viewport className="size-full">{children}</ScrollPrimitive.Viewport>
      <ScrollPrimitive.Scrollbar orientation="vertical" className="w-2 bg-surface-2">
        <ScrollPrimitive.Thumb className="rounded-full bg-fg-muted" />
      </ScrollPrimitive.Scrollbar>
    </ScrollPrimitive.Root>
  );
}
