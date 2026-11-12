import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { VoucherView } from '@/components/accounting/voucher-view';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('accounting.voucher'))('title') };
}

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <VoucherView id={Number(id)} />;
}
