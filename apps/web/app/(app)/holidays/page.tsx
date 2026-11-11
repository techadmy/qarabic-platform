import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { HolidaysView } from './holidays-view';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('holidays'))('title') };
}

export default function Page() {
  return <HolidaysView />;
}
