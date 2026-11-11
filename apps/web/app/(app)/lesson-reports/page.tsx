import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { LessonReportsView } from './lesson-reports-view';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('reports.list'))('title') };
}

export default function Page() {
  return <LessonReportsView />;
}
