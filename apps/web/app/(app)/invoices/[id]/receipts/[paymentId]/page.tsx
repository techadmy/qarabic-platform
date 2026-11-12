import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { ReceiptView } from '@/components/billing/receipt-view';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('billing.receipt'))('title') };
}

export default async function Page({
  params,
}: {
  params: Promise<{ id: string; paymentId: string }>;
}) {
  const { id, paymentId } = await params;
  return <ReceiptView invoiceId={Number(id)} paymentId={Number(paymentId)} />;
}
