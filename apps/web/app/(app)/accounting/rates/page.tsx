import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { RatesView } from '@/components/accounting/rates-view';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('accounting.rates'))('title') };
}

export default function Page() {
  return <RatesView />;
}
