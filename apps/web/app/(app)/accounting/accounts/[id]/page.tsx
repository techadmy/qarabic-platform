import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { StatementView } from '@/components/accounting/statement-view';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('accounting.statement'))('title') };
}

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <StatementView id={Number(id)} />;
}
