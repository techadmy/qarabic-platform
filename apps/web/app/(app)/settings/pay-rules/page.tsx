import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { PayRulesView } from '@/components/payroll/pay-rules-view';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('payroll.rules'))('title') };
}

export default function Page() {
  return <PayRulesView />;
}
