import { Command as CommandPrimitive } from 'cmdk';
import { ChevronsUpDown } from 'lucide-react';
import * as React from 'react';

import { cn } from '../lib/cn';

import { Popover, PopoverContent, PopoverTrigger } from './overlays';
import { focusRing } from './primitives';

export function Command({ className, ...props }: React.ComponentProps<typeof CommandPrimitive>) {
  return <CommandPrimitive className={cn('flex flex-col text-sm text-fg', className)} {...props} />;
}

export function CommandInput({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Input>) {
  return (
    <CommandPrimitive.Input
      className={cn(
        'h-(--control-h) border-b border-border bg-transparent px-(--pad-x) outline-none placeholder:text-fg-muted',
        className,
      )}
      {...props}
    />
  );
}

export function CommandList({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.List>) {
  return (
    <CommandPrimitive.List className={cn('max-h-64 overflow-auto p-1', className)} {...props} />
  );
}

export function CommandEmpty(props: React.ComponentProps<typeof CommandPrimitive.Empty>) {
  return <CommandPrimitive.Empty className="p-3 text-center text-fg-muted" {...props} />;
}

export function CommandGroup(props: React.ComponentProps<typeof CommandPrimitive.Group>) {
  return <CommandPrimitive.Group {...props} />;
}

export function CommandItem({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Item>) {
  return (
    <CommandPrimitive.Item
      className={cn(
        'flex h-(--control-h) cursor-default items-center rounded-sm px-2 data-[selected=true]:bg-surface-2',
        className,
      )}
      {...props}
    />
  );
}

export interface ComboboxOption {
  value: string;
  label: string;
}

export interface ComboboxProps {
  options: ComboboxOption[];
  value: string | null;
  onChange: (value: string) => void;
  placeholder?: string;
  searchPlaceholder?: string;
  emptyText?: string;
  className?: string;
}

/** Searchable single-select built from Popover + Command. */
export function Combobox({
  options,
  value,
  onChange,
  placeholder = 'Select…',
  searchPlaceholder = 'Search…',
  emptyText = 'No results',
  className,
}: ComboboxProps) {
  const [open, setOpen] = React.useState(false);
  const listId = React.useId();
  const selected = options.find((o) => o.value === value);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          role="combobox"
          aria-expanded={open}
          aria-controls={listId}
          className={cn(
            `flex h-(--control-h) w-full items-center justify-between rounded-md border border-border bg-bg px-(--pad-x) text-sm ${focusRing}`,
            className,
          )}
        >
          <span className={selected ? '' : 'text-fg-muted'}>{selected?.label ?? placeholder}</span>
          <ChevronsUpDown size={14} aria-hidden />
        </button>
      </PopoverTrigger>
      <PopoverContent id={listId} className="w-(--radix-popover-trigger-width) p-0">
        <Command>
          <CommandInput placeholder={searchPlaceholder} />
          <CommandList>
            <CommandEmpty>{emptyText}</CommandEmpty>
            {options.map((o) => (
              <CommandItem
                key={o.value}
                value={o.label}
                onSelect={() => {
                  onChange(o.value);
                  setOpen(false);
                }}
              >
                {o.label}
              </CommandItem>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
