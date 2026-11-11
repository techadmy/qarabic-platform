import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { TicketDetailView } from '@/components/support/ticket-detail';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('nav'))('ticket') };
}

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <TicketDetailView id={Number(id)} />;
}
