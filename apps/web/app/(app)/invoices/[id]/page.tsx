import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { InvoiceRoute } from '@/components/billing/routes';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('billing.detail'))('title') };
}

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <InvoiceRoute id={Number(id)} />;
}
