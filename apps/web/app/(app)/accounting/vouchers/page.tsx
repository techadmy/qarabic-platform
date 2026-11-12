import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { VouchersView } from '@/components/accounting/vouchers-view';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('accounting.vouchers'))('title') };
}

export default function Page() {
  return <VouchersView />;
}
