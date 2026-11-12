'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { useTranslations } from 'next-intl';
import { useMemo } from 'react';
import type { FieldErrors, FieldValues, Resolver } from 'react-hook-form';
import type { z } from 'zod';

/**
 * Per-parse zod error map with our translated messages. The shared schemas stay free of UI copy;
 * the form passes this map to `zodResolver(schema, { error })`.
 */
export function useValidationMessages() {
  const t = useTranslations('validation');
  return useMemo(
    () =>
      ({
        error: (issue: z.core.$ZodRawIssue) => {
          const input = issue.input;
          const empty = input === undefined || input === null || input === '';
          if (issue.code === 'invalid_format' && issue.format === 'email') {
            return input === '' ? t('required') : t('email');
          }
          if (issue.code === 'too_small' && issue.origin === 'string') {
            return Number(issue.minimum) <= 1
              ? t('required')
              : t('passwordMin', { count: Number(issue.minimum) });
          }
          if (issue.code === 'too_big' && issue.origin === 'string') {
            return t('passwordMax', { count: Number(issue.maximum) });
          }
          if (issue.code === 'too_small' && issue.origin === 'number') {
            return t('numberMin', { min: Number(issue.minimum) });
          }
          if (issue.code === 'too_big' && issue.origin === 'number') {
            return t('numberMax', { max: Number(issue.maximum) });
          }
          if (issue.code === 'invalid_type' || issue.code === 'invalid_value') {
            return empty ? t('required') : t('invalidChoice');
          }
          if (issue.code === 'invalid_format') return t('invalid');
          return undefined;
        },
      }) satisfies z.core.ParseContext<z.core.$ZodIssue>,
    [t],
  );
}

/** English messages fixed inside the shared schemas → our message keys. */
const SCHEMA_MESSAGES: Record<string, string> = {
  'Use the international format, e.g. +447700900123.': 'phone',
  'Unknown time zone.': 'timezone',
  'Unknown country code.': 'invalidChoice',
  'A reason is required for this status.': 'reasonRequired',
  'Use a positive amount with at most 2 decimals.': 'amount',
  'The amount may not be greater than 100000.': 'amountMax',
  'Use a 3-letter currency code.': 'invalid',
  'Courses must be distinct.': 'invalid',
  'Enter your current password.': 'currentPasswordRequired',
  'Choose the permissions or a role to copy.': 'invalid',
  'Unknown permission.': 'invalid',
  'Enter a phone number or an email address.': 'phoneOrEmail',
};

function translateErrors(errors: FieldErrors, t: (key: string) => string) {
  for (const value of Object.values(errors)) {
    if (!value || typeof value !== 'object') continue;
    const error = value as { message?: unknown };
    if (typeof error.message === 'string' && SCHEMA_MESSAGES[error.message]) {
      error.message = t(SCHEMA_MESSAGES[error.message]!);
    } else if (!('type' in error)) {
      translateErrors(value as FieldErrors, t);
    }
  }
}

/**
 * `zodResolver` for a shared schema with our messages: the error map above, plus a pass that turns
 * the few English messages fixed in the shared schemas into the UI language.
 */
export function useSchemaResolver<In extends FieldValues, Out>(
  schema: z.ZodType<Out, In>,
): Resolver<In, unknown, Out> {
  const messages = useValidationMessages();
  const t = useTranslations('validation');
  return useMemo(() => {
    const base = zodResolver(schema as never, messages) as unknown as Resolver<In, unknown, Out>;
    const resolver: Resolver<In, unknown, Out> = async (values, context, options) => {
      const result = await base(values, context, options);
      translateErrors(result.errors as FieldErrors, (key) => t(key));
      return result;
    };
    return resolver;
  }, [schema, messages, t]);
}
