import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { FamilyProfile } from './family-profile';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('families'))('profileTitle') };
}

export default async function FamilyPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <FamilyProfile id={Number(id)} />;
}
