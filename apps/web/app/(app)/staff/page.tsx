import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { StaffView } from './staff-view';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('staff'))('title') };
}

export default function StaffPage() {
  return <StaffView />;
}
