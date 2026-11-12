import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { EntryForm } from '@/components/accounting/entry-form';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('accounting.entry'))('newTitle') };
}

export default function Page() {
  return <EntryForm />;
}
