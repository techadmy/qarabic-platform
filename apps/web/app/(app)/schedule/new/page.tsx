import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { NewEnrollmentView } from './new-enrollment-view';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('schedule.new'))('title') };
}

export default function Page() {
  return <NewEnrollmentView />;
}
