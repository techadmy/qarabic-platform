'use client';

import { CONFLICT_LABELS, type ConflictCode, type ConflictResultDto } from '@qarabic/shared';
import { Alert, AlertDescription, AlertTitle } from '@qarabic/ui/components/alert';
import { Checkbox } from '@qarabic/ui/components/checkbox';
import { Field, FieldLabel } from '@qarabic/ui/components/field';
import { Spinner } from '@qarabic/ui/components/spinner';
import { CircleCheckIcon, OctagonXIcon, TriangleAlertIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { formatDate } from '@/lib/time';
import { useUiLocale } from './times';

/** Every hard conflict blocks; every soft warning needs its tick (docs/14 §5). */
export function canSave(result: ConflictResultDto | undefined | null, acknowledged: string[]) {
  if (!result) return false;
  return (
    result.conflicts.length === 0 && result.warnings.every((w) => acknowledged.includes(w.code))
  );
}

/**
 * Conflicts before saving (docs/15 §6.3): hard ones in a destructive shadcn `Alert` (no override),
 * soft ones in a warning `Alert` with a `Checkbox` each to acknowledge, «لا يوجد تعارض» when clear.
 */
export function ConflictList({
  result,
  checking,
  acknowledged,
  onAcknowledge,
}: {
  result: ConflictResultDto | undefined | null;
  checking?: boolean;
  acknowledged: string[];
  onAcknowledge: (codes: string[]) => void;
}) {
  const t = useTranslations('classes.conflicts');
  const locale = useUiLocale();
  const label = (code: string, fallback: string) =>
    CONFLICT_LABELS[code as ConflictCode]?.[locale] ?? fallback;

  if (checking && !result) {
    return (
      <p className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
        <Spinner /> {t('checking')}
      </p>
    );
  }
  if (!result) return null;
  if (!result.conflicts.length && !result.warnings.length) {
    return (
      <Alert role="status">
        <CircleCheckIcon className="text-emerald-700" />
        <AlertTitle>{t('none')}</AlertTitle>
      </Alert>
    );
  }
  return (
    <div className="flex flex-col gap-3" aria-live="polite">
      {result.conflicts.length > 0 && (
        <Alert variant="destructive" role="alert">
          <OctagonXIcon />
          <AlertTitle>{t('hardTitle')}</AlertTitle>
          <AlertDescription>
            <ul className="list-inside list-disc">
              {result.conflicts.map((c, i) => (
                <li key={`${c.code}-${i}`}>
                  {label(c.code, c.message)}
                  {c.with?.label && (
                    <>
                      {' '}
                      — <bdi>{c.with.label}</bdi>
                    </>
                  )}
                  {c.firstDate && (
                    <span className="text-muted-foreground">
                      {' '}
                      ({t('from', { date: formatDate(c.firstDate, locale) ?? c.firstDate })})
                    </span>
                  )}
                </li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      )}
      {result.warnings.length > 0 && (
        <Alert className="border-amber-300 bg-amber-50 text-amber-950 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-100">
          <TriangleAlertIcon />
          <AlertTitle>{t('softTitle')}</AlertTitle>
          <AlertDescription className="text-inherit">
            <div className="mt-1 flex flex-col gap-2">
              {result.warnings.map((w) => {
                const id = `ack-${w.code}`;
                const checked = acknowledged.includes(w.code);
                return (
                  <Field key={w.code} orientation="horizontal">
                    <Checkbox
                      id={id}
                      checked={checked}
                      onCheckedChange={(v) =>
                        onAcknowledge(
                          v
                            ? [...acknowledged, w.code]
                            : acknowledged.filter((code) => code !== w.code),
                        )
                      }
                    />
                    <FieldLabel htmlFor={id} className="font-normal">
                      {label(w.code, w.message)}
                      {w.with?.label && (
                        <>
                          {' '}
                          — <bdi>{w.with.label}</bdi>
                        </>
                      )}
                    </FieldLabel>
                  </Field>
                );
              })}
            </div>
          </AlertDescription>
        </Alert>
      )}
    </div>
  );
}
