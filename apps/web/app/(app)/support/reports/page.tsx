import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { SupportReportView } from '@/components/support/support-report-view';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('support.reports'))('title') };
}

export default function Page() {
  return <SupportReportView />;
}
