import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { AvailabilityQueueView } from './queue-view';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('availability'))('queueTitle') };
}

export default function Page() {
  return <AvailabilityQueueView />;
}
