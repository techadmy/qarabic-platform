import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { InvoicesRoute } from '@/components/billing/routes';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('billing.invoices'))('title') };
}

export default function Page() {
  return <InvoicesRoute />;
}
