import { Button } from '@qarabic/ui/components/button';
import { ArrowRightIcon } from 'lucide-react';
import Link from 'next/link';
import type { MouseEvent, ReactNode } from 'react';

/**
 * Page title (one h1 per page) + optional description and count, with the page's actions at the
 * inline-end (docs/15 §5.2, F10: «أضف …» lives on the list page header). Detail pages pass `back`
 * for the arrow before the title, as in the current app.
 */
export function PageHeader({
  title,
  description,
  meta,
  actions,
  back,
  leading,
}: {
  title: ReactNode;
  description?: ReactNode;
  meta?: ReactNode;
  actions?: ReactNode;
  back?: { href: string; label: string; onClick?: (event: MouseEvent<HTMLAnchorElement>) => void };
  /** Shown between the back arrow and the title (e.g. the avatar). */
  leading?: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
      <div className="flex min-w-0 items-start gap-3">
        {back && (
          <Button variant="ghost" size="icon-lg" asChild className="mt-0.5 shrink-0">
            <Link href={back.href} aria-label={back.label} onClick={back.onClick}>
              <ArrowRightIcon className="ltr:rotate-180" />
            </Link>
          </Button>
        )}
        {leading}
        <div className="flex min-w-0 flex-col gap-1">
          <h1 className="text-2xl font-bold tracking-normal break-words">{title}</h1>
          {description && <div className="text-muted-foreground">{description}</div>}
          {meta && <div className="text-sm text-muted-foreground">{meta}</div>}
        </div>
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2 sm:shrink-0">{actions}</div>}
    </div>
  );
}
