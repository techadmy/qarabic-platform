import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { ScheduleView } from './schedule-view';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('schedule'))('title') };
}

export default function Page() {
  return <ScheduleView />;
}
