import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { CalendarView } from '@/components/calendar/calendar-view';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('calendar'))('title') };
}

export default function Page() {
  return <CalendarView />;
}
