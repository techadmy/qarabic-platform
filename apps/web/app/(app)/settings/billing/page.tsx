import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { BillingSettingsView } from '@/components/billing/billing-settings-view';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('billing.settings'))('title') };
}

export default function Page() {
  return <BillingSettingsView />;
}
