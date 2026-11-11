import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { AvailabilityView } from './availability-view';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('schedule.availabilityPage'))('title') };
}

export default function Page() {
  return <AvailabilityView />;
}
