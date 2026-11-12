import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { JournalView } from '@/components/accounting/journal-view';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('accounting.journal'))('title') };
}

export default function Page() {
  return <JournalView />;
}
