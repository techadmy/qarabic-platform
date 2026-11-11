import type { FieldValues, Path, UseFormSetError, UseFormSetFocus } from 'react-hook-form';
import { isApiError } from '@/lib/api/client';

/** Server messages we can say in the UI language; anything else becomes a generic "check this". */
const KNOWN: [RegExp, string][] = [
  [/already been taken|already used/i, 'taken'],
  [/required|too small: expected string to have >=1/i, 'required'],
  [/invalid email/i, 'email'],
  [/selected .* is invalid|invalid\.?$/i, 'invalidChoice'],
  [/international format/i, 'phone'],
  [/time zone/i, 'timezone'],
  [/current password/i, 'wrongPassword'],
];

export function serverMessageKey(message: string | undefined): string {
  return KNOWN.find(([re]) => re.test(message ?? ''))?.[1] ?? 'invalid';
}

/**
 * Maps a 422 `validation_failed` answer onto the form fields (UX §5.6) and focuses the first one.
 * `translate` turns a key from `serverMessageKey` into copy. Returns false when the error was not a
 * field error (the caller shows a toast or banner instead).
 */
export function applyServerErrors<T extends FieldValues>(
  form: { setError: UseFormSetError<T>; setFocus: UseFormSetFocus<T> },
  error: unknown,
  translate: (key: string) => string,
  fields: readonly string[],
): boolean {
  if (!isApiError(error, 422) || !error.error?.errors) return false;
  let first: string | null = null;
  for (const [key, messages] of Object.entries(error.error.errors)) {
    // `permissions.3` → `permissions`; unknown keys are not form fields.
    const field = key.split('.')[0]!;
    if (!fields.includes(field)) continue;
    form.setError(field as Path<T>, {
      type: 'server',
      message: translate(serverMessageKey(messages[0])),
    });
    first ??= field;
  }
  if (first) form.setFocus(first as Path<T>);
  return first !== null;
}
