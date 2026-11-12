import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { LeadsView } from '@/components/crm/leads-view';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('crm'))('title') };
}

export default function Page() {
  return <LeadsView />;
}
