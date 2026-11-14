import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { TrialsTodayView } from '@/components/crm/trials-today-view';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('crm.trialsToday'))('title') };
}

export default function TrialsTodayPage() {
  return <TrialsTodayView />;
}
