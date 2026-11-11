import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { RequestsView } from './requests-view';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('requests'))('title') };
}

export default function Page() {
  return <RequestsView />;
}
