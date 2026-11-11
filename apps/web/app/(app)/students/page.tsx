import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { StudentsView } from './students-view';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('students'))('title') };
}

export default function StudentsPage() {
  return <StudentsView />;
}
