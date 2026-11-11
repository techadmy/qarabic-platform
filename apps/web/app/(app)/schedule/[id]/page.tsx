import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { EnrollmentView } from './enrollment-view';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('schedule'))('detailPageTitle') };
}

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <EnrollmentView id={Number(id)} />;
}
