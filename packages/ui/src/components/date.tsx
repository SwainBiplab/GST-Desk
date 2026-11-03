import { CalendarDays } from 'lucide-react';
import * as React from 'react';
import { DayPicker } from 'react-day-picker';

import { formatDate } from '../format';
import { cn } from '../lib/cn';

import { Popover, PopoverContent, PopoverTrigger } from './overlays';
import { focusRing } from './primitives';

export type CalendarProps = React.ComponentProps<typeof DayPicker>;

export function Calendar({ className, ...props }: CalendarProps) {
  return <DayPicker className={cn('text-sm text-fg', className)} {...props} />;
}

export interface DatePickerProps {
  value: Date | null;
  onChange: (value: Date | undefined) => void;
  placeholder?: string;
  className?: string;
}

/** Shows dates as dd-MM-yyyy. */
export function DatePicker({
  value,
  onChange,
  placeholder = 'dd-mm-yyyy',
  className,
}: DatePickerProps) {
  const [open, setOpen] = React.useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(
            `tabular flex h-(--control-h) w-full items-center justify-between rounded-md border border-border bg-bg px-(--pad-x) text-sm ${focusRing}`,
            className,
          )}
        >
          <span className={value ? '' : 'text-fg-muted'}>
            {value ? formatDate(value) : placeholder}
          </span>
          <CalendarDays size={14} aria-hidden />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-auto">
        <Calendar
          mode="single"
          selected={value ?? undefined}
          onSelect={(d) => {
            onChange(d);
            setOpen(false);
          }}
        />
      </PopoverContent>
    </Popover>
  );
}
