'use client';

import { Button } from '@qarabic/ui/components/button';
import { cn } from '@qarabic/ui/lib/utils';
import { useTranslations } from 'next-intl';
import { useSwitchLocale } from '@/hooks/use-switch-locale';

/**
 * The other language's name as a ghost button in the brand colour, as in the current app's top bar
 * and login page («English» / «العربية»). Signed in, the choice is saved on the account too.
 */
export function LanguageSwitch({ className, persist }: { className?: string; persist?: boolean }) {
  const t = useTranslations('languages');
  const { other, switchTo, pending } = useSwitchLocale();
  return (
    <Button
      type="button"
      variant="ghost"
      lang={other}
      onClick={() => switchTo(other, { persist })}
      disabled={pending}
      aria-label={t('switchToLabel')}
      className={cn(
        'h-9 px-3 text-[0.9375rem] font-semibold text-primary hover:text-primary',
        className,
      )}
    >
      {t('switchTo')}
    </Button>
  );
}
