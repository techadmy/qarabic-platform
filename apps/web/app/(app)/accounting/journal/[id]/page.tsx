import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { EntryView } from '@/components/accounting/entry-view';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('accounting.entry'))('title') };
}

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <EntryView id={Number(id)} />;
}
