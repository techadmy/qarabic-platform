import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { AccountView } from './account-view';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('account'))('title') };
}

export default function AccountPage() {
  return <AccountView />;
}
