import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { TodayView } from './today-view';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('today'))('title') };
}

export default function Page() {
  return <TodayView />;
}
