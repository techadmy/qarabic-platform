import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { MyScheduleView } from './my-schedule-view';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('teacherPortal'))('mySchedule') };
}

export default function Page() {
  return <MyScheduleView />;
}
