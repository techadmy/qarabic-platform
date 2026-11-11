import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { StudentProfile } from './student-profile';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('students'))('profileTitle') };
}

export default async function StudentPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <StudentProfile id={Number(id)} />;
}
