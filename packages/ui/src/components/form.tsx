import * as React from 'react';
import {
  Controller,
  FormProvider,
  useFormContext,
  type ControllerProps,
  type FieldPath,
  type FieldValues,
} from 'react-hook-form';

import { cn } from '../lib/cn';

export const Form = FormProvider;

const FieldIdContext = React.createContext<string>('');

export interface FormFieldProps<T extends FieldValues, N extends FieldPath<T>> {
  name: N;
  label: string;
  hint?: string;
  render: ControllerProps<T, N>['render'];
}

/** Label + control + hint/error wiring for react-hook-form. */
export function FormField<T extends FieldValues, N extends FieldPath<T>>({
  name,
  label,
  hint,
  render,
}: FormFieldProps<T, N>) {
  const { control, getFieldState, formState } = useFormContext<T>();
  const id = React.useId();
  const error = getFieldState(name, formState).error;
  return (
    <FieldIdContext.Provider value={id}>
      <div className="flex flex-col gap-1">
        <label htmlFor={id} className="text-sm font-medium">
          {label}
        </label>
        <Controller control={control} name={name} render={render} />
        {error ? (
          <p role="alert" className="text-xs text-danger">
            {error.message}
          </p>
        ) : hint ? (
          <p className="text-xs text-fg-muted">{hint}</p>
        ) : null}
      </div>
    </FieldIdContext.Provider>
  );
}

export function useFieldId() {
  return React.useContext(FieldIdContext);
}

export function FormActions({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('flex justify-end gap-2 pt-2', className)} {...props} />;
}
