import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { AnnouncementsView } from '@/components/operations/announcements-view';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('operations.announcements'))('title') };
}

export default function Page() {
  return <AnnouncementsView />;
}
