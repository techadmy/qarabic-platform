import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { TimetableView } from './timetable-view';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('timetable'))('pageTitle') };
}

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <TimetableView id={Number(id)} />;
}
