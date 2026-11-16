import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { UtilizationView } from '@/components/reports/utilization-view';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('utilization'))('title') };
}

export default function Page() {
  return <UtilizationView />;
}
