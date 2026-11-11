import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { TestDetailView } from './test-detail-view';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('tests'))('pageTitle') };
}

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <TestDetailView id={Number(id)} />;
}
