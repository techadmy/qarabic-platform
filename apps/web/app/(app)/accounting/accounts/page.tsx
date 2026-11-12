import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { AccountsView } from '@/components/accounting/accounts-view';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('accounting.accounts'))('title') };
}

export default function Page() {
  return <AccountsView />;
}
