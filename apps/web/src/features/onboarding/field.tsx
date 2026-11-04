import { cn } from '@gst/ui';
import { useId } from 'react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

export interface FieldProps {
  label: string;
  /** Error key from the validators (`val.<key>`). */
  error?: string | undefined;
  hint?: string | undefined;
  className?: string;
  /** Receives the id and aria props to put on the control. */
  children: (control: {
    id: string;
    'aria-invalid': boolean;
    'aria-describedby': string | undefined;
  }) => ReactNode;
}

/** Label, control and an inline message wired together for screen readers. */
export function Field({ label, error, hint, className, children }: FieldProps) {
  const { t } = useTranslation();
  const id = useId();
  const messageId = `${id}-msg`;
  const message = error ? t(`val.${error}`) : hint;
  return (
    <div className={cn('flex flex-col gap-1', className)}>
      <label htmlFor={id} className="text-sm font-medium">
        {label}
      </label>
      {children({
        id,
        'aria-invalid': !!error,
        'aria-describedby': message ? messageId : undefined,
      })}
      {message && (
        <p
          id={messageId}
          role={error ? 'alert' : undefined}
          className={cn('text-xs', error ? 'text-danger' : 'text-fg-muted')}
        >
          {message}
        </p>
      )}
    </div>
  );
}
