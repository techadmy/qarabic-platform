import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { AttendanceRoute } from '@/components/payroll/routes';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('payroll.attendance'))('title') };
}

export default function Page() {
  return <AttendanceRoute />;
}
