import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { TriageView } from '@/components/support/triage-view';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('support.feedback'))('title') };
}

export default function Page() {
  return <TriageView />;
}
