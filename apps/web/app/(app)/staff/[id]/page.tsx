import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { StaffProfile } from './staff-profile';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('staff'))('profileTitle') };
}

export default async function StaffMemberPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <StaffProfile id={Number(id)} />;
}
