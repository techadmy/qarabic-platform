import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { LeadWorkbench } from '@/components/crm/lead-workbench';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('crm.work'))('title') };
}

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <LeadWorkbench id={Number(id)} />;
}
