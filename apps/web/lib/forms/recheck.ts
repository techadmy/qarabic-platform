'use client';

import { useEffect } from 'react';
import { useWatch, type FieldValues, type Path, type UseFormReturn } from 'react-hook-form';

/**
 * Re-validates `target` when `source` changes while `target` shows an error — for cross-field
 * rules such as "a phone number or an email": typing the email clears the phone's error at once.
 */
export function useRecheckOnChange<T extends FieldValues>(
  form: UseFormReturn<T>,
  source: Path<T>,
  target: Path<T>,
) {
  const value = useWatch({ control: form.control, name: source });
  const { trigger, getFieldState, formState } = form;
  useEffect(() => {
    if (getFieldState(target, formState).invalid) void trigger(target);
    // Only a change of `source` should re-run this.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);
}
