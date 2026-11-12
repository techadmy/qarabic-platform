import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { PackagesView } from '@/components/billing/packages-view';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('billing.packages'))('title') };
}

export default function Page() {
  return <PackagesView />;
}
