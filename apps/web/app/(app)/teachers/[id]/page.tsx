import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { TeacherProfile } from './teacher-profile';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('teachers'))('profileTitle') };
}

export default async function TeacherPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <TeacherProfile id={Number(id)} />;
}
