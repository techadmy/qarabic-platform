import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { ProfilesView } from '@/components/payroll/profiles-view';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('payroll.profiles'))('title') };
}

export default function Page() {
  return <ProfilesView />;
}
