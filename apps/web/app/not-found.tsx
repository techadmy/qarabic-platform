import { Button } from '@qarabic/ui/components/button';
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from '@qarabic/ui/components/empty';
import { getTranslations } from 'next-intl/server';
import Link from 'next/link';

export default async function NotFound() {
  const t = await getTranslations('errors');
  return (
    <main className="flex min-h-svh items-center justify-center p-6">
      <Empty>
        <EmptyHeader>
          <EmptyTitle>
            <h1>{t('notFoundTitle')}</h1>
          </EmptyTitle>
          <EmptyDescription>{t('notFound')}</EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Button asChild>
            <Link href="/">{t('goHome')}</Link>
          </Button>
        </EmptyContent>
      </Empty>
    </main>
  );
}
