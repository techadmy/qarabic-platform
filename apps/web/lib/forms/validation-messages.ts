'use client';

import { useTranslations } from 'next-intl';
import { useMemo } from 'react';
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
          if (issue.code === 'invalid_format' && issue.format === 'email') {
            return issue.input === '' ? t('required') : t('email');
          }
          if (issue.code === 'too_small' && issue.origin === 'string') {
            return Number(issue.minimum) <= 1
              ? t('required')
              : t('passwordMin', { count: Number(issue.minimum) });
          }
          return undefined;
        },
      }) satisfies z.core.ParseContext<z.core.$ZodIssue>,
    [t],
  );
}
