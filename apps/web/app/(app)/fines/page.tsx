import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { FinesView } from '@/components/payroll/fines-view';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('payroll.fines'))('title') };
}

export default function Page() {
  return <FinesView />;
}
