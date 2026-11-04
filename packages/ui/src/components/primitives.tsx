import { cva, type VariantProps } from 'class-variance-authority';
import { Check, ChevronDown, Circle } from 'lucide-react';
import {
  Checkbox as CheckboxPrimitive,
  RadioGroup as RadioPrimitive,
  Select as SelectPrimitive,
  Slot,
  Switch as SwitchPrimitive,
} from 'radix-ui';
import * as React from 'react';

import { cn } from '../lib/cn';

export const focusRing =
  'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring';

/* ---------- Button ---------- */
const buttonVariants = cva(
  `inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md px-(--pad-x) h-(--control-h) text-sm font-medium transition-colors disabled:pointer-events-none disabled:opacity-50 ${focusRing}`,
  {
    variants: {
      variant: {
        primary: 'bg-accent text-accent-fg hover:opacity-90',
        secondary: 'bg-surface-2 text-fg hover:bg-surface-3',
        outline: 'border border-border bg-bg text-fg hover:bg-surface-2',
        ghost: 'text-fg hover:bg-surface-2',
        danger: 'bg-danger text-danger-fg hover:opacity-90',
      },
    },
    defaultVariants: { variant: 'primary' },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {
  /** Render the child element (e.g. a router Link) with button styling instead of a <button>. */
  asChild?: boolean | undefined;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, type = 'button', asChild = false, ...props }, ref) => {
    const classes = cn(buttonVariants({ variant }), className);
    if (asChild) return <Slot.Root ref={ref} className={classes} {...props} />;
    return <button ref={ref} type={type} className={classes} {...props} />;
  },
);
Button.displayName = 'Button';

/* ---------- Input / Textarea ---------- */
const fieldClass = `w-full rounded-md border border-border bg-bg px-(--pad-x) text-sm text-fg placeholder:text-fg-muted disabled:opacity-50 aria-invalid:border-danger ${focusRing}`;

export const Input = React.forwardRef<
  HTMLInputElement,
  React.InputHTMLAttributes<HTMLInputElement>
>(({ className, ...props }, ref) => (
  <input ref={ref} className={cn(fieldClass, 'h-(--control-h)', className)} {...props} />
));
Input.displayName = 'Input';

export const Textarea = React.forwardRef<
  HTMLTextAreaElement,
  React.TextareaHTMLAttributes<HTMLTextAreaElement>
>(({ className, ...props }, ref) => (
  <textarea ref={ref} className={cn(fieldClass, 'min-h-20 py-2', className)} {...props} />
));
Textarea.displayName = 'Textarea';

/* ---------- Select ---------- */
export const Select = SelectPrimitive.Root;
export const SelectValue = SelectPrimitive.Value;

export const SelectTrigger = React.forwardRef<
  HTMLButtonElement,
  React.ComponentPropsWithoutRef<typeof SelectPrimitive.Trigger>
>(({ className, children, ...props }, ref) => (
  <SelectPrimitive.Trigger
    ref={ref}
    className={cn(fieldClass, 'flex h-(--control-h) items-center justify-between', className)}
    {...props}
  >
    {children}
    <SelectPrimitive.Icon>
      <ChevronDown size={14} aria-hidden />
    </SelectPrimitive.Icon>
  </SelectPrimitive.Trigger>
));
SelectTrigger.displayName = 'SelectTrigger';

export const SelectContent = React.forwardRef<
  HTMLDivElement,
  React.ComponentPropsWithoutRef<typeof SelectPrimitive.Content>
>(({ className, children, ...props }, ref) => (
  <SelectPrimitive.Portal>
    <SelectPrimitive.Content
      ref={ref}
      position="popper"
      className={cn(
        'z-(--z-dropdown) max-h-72 min-w-(--radix-select-trigger-width) overflow-y-auto rounded-md border border-border bg-surface-1 p-1 text-fg shadow-md',
        className,
      )}
      {...props}
    >
      <SelectPrimitive.Viewport>{children}</SelectPrimitive.Viewport>
    </SelectPrimitive.Content>
  </SelectPrimitive.Portal>
));
SelectContent.displayName = 'SelectContent';

export const SelectItem = React.forwardRef<
  HTMLDivElement,
  React.ComponentPropsWithoutRef<typeof SelectPrimitive.Item>
>(({ className, children, ...props }, ref) => (
  <SelectPrimitive.Item
    ref={ref}
    className={cn(
      'relative flex h-(--control-h) cursor-default select-none items-center rounded-sm pl-6 pr-2 text-sm outline-none data-highlighted:bg-surface-2',
      className,
    )}
    {...props}
  >
    <SelectPrimitive.ItemIndicator className="absolute left-1.5">
      <Check size={12} aria-hidden />
    </SelectPrimitive.ItemIndicator>
    <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
  </SelectPrimitive.Item>
));
SelectItem.displayName = 'SelectItem';

/* ---------- Checkbox / Radio / Switch ---------- */
export const Checkbox = React.forwardRef<
  HTMLButtonElement,
  React.ComponentPropsWithoutRef<typeof CheckboxPrimitive.Root>
>(({ className, ...props }, ref) => (
  <CheckboxPrimitive.Root
    ref={ref}
    className={cn(
      `flex size-4 items-center justify-center rounded-sm border border-border bg-bg data-[state=checked]:border-accent data-[state=checked]:bg-accent data-[state=checked]:text-accent-fg ${focusRing}`,
      className,
    )}
    {...props}
  >
    <CheckboxPrimitive.Indicator>
      <Check size={12} aria-hidden />
    </CheckboxPrimitive.Indicator>
  </CheckboxPrimitive.Root>
));
Checkbox.displayName = 'Checkbox';

export const RadioGroup = RadioPrimitive.Root;

export const RadioGroupItem = React.forwardRef<
  HTMLButtonElement,
  React.ComponentPropsWithoutRef<typeof RadioPrimitive.Item>
>(({ className, ...props }, ref) => (
  <RadioPrimitive.Item
    ref={ref}
    className={cn(
      `flex size-4 items-center justify-center rounded-full border border-border bg-bg ${focusRing}`,
      className,
    )}
    {...props}
  >
    <RadioPrimitive.Indicator>
      <Circle size={8} className="fill-accent text-accent" aria-hidden />
    </RadioPrimitive.Indicator>
  </RadioPrimitive.Item>
));
RadioGroupItem.displayName = 'RadioGroupItem';

export const Switch = React.forwardRef<
  HTMLButtonElement,
  React.ComponentPropsWithoutRef<typeof SwitchPrimitive.Root>
>(({ className, ...props }, ref) => (
  <SwitchPrimitive.Root
    ref={ref}
    className={cn(
      `inline-flex h-5 w-9 items-center rounded-full bg-surface-3 data-[state=checked]:bg-accent ${focusRing}`,
      className,
    )}
    {...props}
  >
    <SwitchPrimitive.Thumb className="block size-4 translate-x-0.5 rounded-full bg-bg transition-transform data-[state=checked]:translate-x-4.5" />
  </SwitchPrimitive.Root>
));
Switch.displayName = 'Switch';
