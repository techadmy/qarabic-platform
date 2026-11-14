import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { LeadKpisView } from '@/components/crm/lead-kpis-view';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('crm.kpis'))('title') };
}

export default function LeadKpisPage() {
  return <LeadKpisView />;
}
