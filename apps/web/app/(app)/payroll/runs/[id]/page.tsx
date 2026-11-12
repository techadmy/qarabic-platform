import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { RunView } from '@/components/payroll/run-view';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('payroll.run'))('back') };
}

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <RunView id={Number(id)} />;
}
