import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { TestsView } from './tests-view';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('tests'))('title') };
}

export default function Page() {
  return <TestsView />;
}
