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

/** Empty, error and no-access states, all from the shadcn `Empty` component (docs/15 §5.8). */
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
  return (
    <Empty className="border border-dashed" role={role}>
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <Icon />
        </EmptyMedia>
        <EmptyTitle>{title}</EmptyTitle>
        <EmptyDescription>{description}</EmptyDescription>
      </EmptyHeader>
      {action && <EmptyContent>{action}</EmptyContent>}
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
