import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { PayslipView } from '@/components/payroll/payslip-view';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('payroll.slip'))('title') };
}

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <PayslipView id={Number(id)} />;
}
