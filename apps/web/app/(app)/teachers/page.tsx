import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { TeachersView } from './teachers-view';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('teachers'))('title') };
}

export default function TeachersPage() {
  return <TeachersView />;
}
