import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { PayrollRoute } from '@/components/payroll/routes';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('payroll'))('pageTitle') };
}

export default function Page() {
  return <PayrollRoute />;
}
