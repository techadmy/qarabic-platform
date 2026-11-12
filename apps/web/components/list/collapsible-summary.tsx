'use client';

import { Button } from '@qarabic/ui/components/button';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@qarabic/ui/components/collapsible';
import { cn } from '@qarabic/ui/lib/utils';
import { ChevronDownIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import type { ReactNode } from 'react';
import { usePersistedState } from '@/hooks/use-persisted-state';

/**
 * The list's summary strip, collapsed by default (D141 §8, Zoho's «ملخص • إظهار التفاصيل»); the
 * choice is remembered per user and list (`storageKey` = list + user id). shadcn `Collapsible`.
 * Not for the Today board («حصص اليوم»): its tiles stay visible (D141).
 * `hint` stays visible when closed (e.g. «3 بلا تواصل»), so nothing urgent hides.
 */
export function CollapsibleSummary({
  storageKey,
  hint,
  children,
}: {
  storageKey: string;
  hint?: ReactNode;
  children: ReactNode;
}) {
  const t = useTranslations('list.summary');
  const [open, setOpen] = usePersistedState(`qarabic.summary.${storageKey}`, false);
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-x-2">
        <CollapsibleTrigger asChild>
          <Button variant="ghost" className="h-9 gap-1 px-2 font-semibold">
            <ChevronDownIcon
              aria-hidden
              className={cn('transition-transform', !open && 'ltr:-rotate-90 rtl:rotate-90')}
            />
            {t('title')}
            <span aria-hidden className="text-muted-foreground">
              •
            </span>
            <span className="font-medium text-primary">{open ? t('hide') : t('show')}</span>
          </Button>
        </CollapsibleTrigger>
        {!open && hint && <span className="text-sm text-muted-foreground">{hint}</span>}
      </div>
      <CollapsibleContent>{children}</CollapsibleContent>
    </Collapsible>
  );
}
