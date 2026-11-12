'use client';

import { Button } from '@qarabic/ui/components/button';
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@qarabic/ui/components/empty';
import { CircleAlertIcon, LockIcon, type LucideIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import type { ReactNode } from 'react';
import { useRecordPane } from '@/components/list/split-view';

/** Empty, error and no-access states, all from the shadcn `Empty` component (docs/15 §5.8), on a white card with a hairline border like the current app's surfaces. */
export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  role,
}: {
  icon: LucideIcon;
  title: string;
  description: string;
  action?: ReactNode;
  role?: 'alert' | 'status';
}) {
  const t = useTranslations('list.split');
  // Not found / no access / failed inside the split view's pane: the record header (with its
  // «إغلاق») is not there, so the state offers the way back to the list itself.
  const pane = useRecordPane();
  const close = role === 'alert' && pane && (
    <Button variant="outline" onClick={pane.onClose}>
      {t('close')}
    </Button>
  );
  return (
    <Empty className="border border-solid bg-card" role={role}>
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <Icon />
        </EmptyMedia>
        <EmptyTitle>{title}</EmptyTitle>
        <EmptyDescription>{description}</EmptyDescription>
      </EmptyHeader>
      {(action || close) && (
        <EmptyContent className="flex-row flex-wrap justify-center">
          {action}
          {close}
        </EmptyContent>
      )}
    </Empty>
  );
}

export function ErrorState({ onRetry }: { onRetry?: () => void }) {
  const t = useTranslations();
  return (
    <EmptyState
      icon={CircleAlertIcon}
      role="alert"
      title={t('errors.loadTitle')}
      description={t('errors.load')}
      action={
        onRetry && (
          <Button variant="outline" onClick={onRetry}>
            {t('common.retry')}
          </Button>
        )
      }
    />
  );
}

export function ForbiddenState() {
  const t = useTranslations('errors');
  return (
    <EmptyState
      icon={LockIcon}
      role="alert"
      title={t('forbiddenTitle')}
      description={t('forbidden')}
    />
  );
}
