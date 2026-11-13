'use client';

import { Alert, AlertAction, AlertTitle } from '@qarabic/ui/components/alert';
import { Button } from '@qarabic/ui/components/button';
import { RefreshCwIcon, TriangleAlertIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';

/** What a polling / refetching view shows for a query: the data it has, and how fresh it is. */
export function refreshState(q: { data?: unknown; isError: boolean }) {
  return {
    /** No data at all and the load failed: the only case for `ErrorState`. */
    failed: q.isError && q.data === undefined,
    /** Data on screen, but the last refresh failed: keep it, say so quietly. */
    stale: q.isError && q.data !== undefined,
  };
}

/**
 * The quiet notice for a view whose background refresh failed (the standing rule from the #32 and
 * #61 reviews): the rows stay, a warning says they may be out of date, «أعد المحاولة» retries.
 */
export function RefreshFailed({ onRetry }: { onRetry: () => void }) {
  const t = useTranslations('list.refresh');
  return (
    <Alert variant="warning">
      <TriangleAlertIcon />
      <AlertTitle>{t('stale')}</AlertTitle>
      <AlertAction>
        <Button size="sm" variant="outline" onClick={onRetry}>
          <RefreshCwIcon />
          {t('retry')}
        </Button>
      </AlertAction>
    </Alert>
  );
}
