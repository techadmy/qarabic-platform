import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { MyStudentsView } from './my-students-view';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('teacherPortal.students'))('title') };
}

export default function Page() {
  return <MyStudentsView />;
}
