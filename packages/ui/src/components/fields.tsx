import * as React from 'react';

import { formatBasisPoints, formatPaise, parsePaise } from '../format';
import { gstinState, type GstinState } from '../format/gstin';
import { cn } from '../lib/cn';

import { Input } from './primitives';

type BaseInput = Omit<React.InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange' | 'type'>;

/* ---------- MoneyInput: paise in, Indian grouping out ---------- */
export interface MoneyInputProps extends BaseInput {
  /** Integer paise. */
  value: bigint | null;
  onValueChange: (paise: bigint | null) => void;
}

export function MoneyInput({
  value,
  onValueChange,
  className,
  onBlur,
  onFocus,
  ...props
}: MoneyInputProps) {
  const [draft, setDraft] = React.useState<string | null>(null);
  const shown = draft ?? (value === null ? '' : formatPaise(value, { symbol: false }));
  return (
    <Input
      {...props}
      inputMode="decimal"
      className={cn('tabular text-right', className)}
      value={shown}
      onFocus={(e) => {
        setDraft(value === null ? '' : (Number(value) / 100).toFixed(2));
        e.currentTarget.select();
        onFocus?.(e);
      }}
      onChange={(e) => {
        setDraft(e.target.value);
        const parsed = parsePaise(e.target.value);
        if (parsed !== null || e.target.value === '') onValueChange(parsed);
      }}
      onBlur={(e) => {
        setDraft(null);
        onBlur?.(e);
      }}
    />
  );
}

/* ---------- MoneyText ---------- */
export interface MoneyTextProps extends React.HTMLAttributes<HTMLSpanElement> {
  paise: bigint | number;
  /** Books mode: negatives in red. */
  negativeRed?: boolean;
}

export function MoneyText({ paise, negativeRed = false, className, ...props }: MoneyTextProps) {
  const negative = BigInt(paise) < 0n;
  return (
    <span className={cn('tabular', negative && negativeRed && 'text-danger', className)} {...props}>
      {formatPaise(paise)}
    </span>
  );
}

/* ---------- PercentInput: basis points ---------- */
export interface PercentInputProps extends BaseInput {
  /** Basis points: 1800 = 18%. */
  value: number | null;
  onValueChange: (bp: number | null) => void;
}

export function PercentInput({ value, onValueChange, className, ...props }: PercentInputProps) {
  const [draft, setDraft] = React.useState<string | null>(null);
  const shown = draft ?? (value === null ? '' : formatBasisPoints(value));
  return (
    <Input
      {...props}
      inputMode="decimal"
      className={cn('tabular text-right', className)}
      value={shown}
      onFocus={() => setDraft(value === null ? '' : String(value / 100))}
      onChange={(e) => {
        setDraft(e.target.value);
        const n = Number(e.target.value.replace('%', ''));
        onValueChange(e.target.value.trim() === '' || Number.isNaN(n) ? null : Math.round(n * 100));
      }}
      onBlur={() => setDraft(null)}
    />
  );
}

/* ---------- GstinInput ---------- */
const gstinMessage: Record<GstinState, string> = {
  empty: '',
  incomplete: 'Keep typing (15 characters)',
  'bad-format': 'Not a valid GSTIN format',
  'bad-checksum': 'Checksum does not match',
  valid: 'Valid GSTIN',
};

export interface GstinInputProps extends BaseInput {
  value: string;
  onValueChange: (value: string) => void;
}

export function GstinInput({ value, onValueChange, className, ...props }: GstinInputProps) {
  const state = gstinState(value);
  const msgId = React.useId();
  return (
    <div className="flex flex-col gap-1">
      <Input
        {...props}
        maxLength={15}
        autoCapitalize="characters"
        spellCheck={false}
        aria-invalid={state === 'bad-format' || state === 'bad-checksum'}
        aria-describedby={msgId}
        className={cn('tabular uppercase', className)}
        value={value}
        onChange={(e) => onValueChange(e.target.value.toUpperCase().replace(/[^0-9A-Z]/g, ''))}
      />
      <span
        id={msgId}
        data-state={state}
        className={cn(
          'text-xs',
          state === 'valid'
            ? 'text-success'
            : state.startsWith('bad')
              ? 'text-danger'
              : 'text-fg-muted',
        )}
      >
        {gstinMessage[state]}
      </span>
    </div>
  );
}
