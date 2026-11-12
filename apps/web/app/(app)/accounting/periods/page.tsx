import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { PeriodsView } from '@/components/accounting/periods-view';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('accounting.periods'))('title') };
}

export default function Page() {
  return <PeriodsView />;
}
