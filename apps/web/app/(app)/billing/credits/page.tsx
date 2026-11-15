import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { CreditsView } from '@/components/billing/credits-view';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('billing.credits'))('title') };
}

export default function Page() {
  return <CreditsView />;
}
