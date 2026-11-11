import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { InboxView } from '@/components/support/inbox-view';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('support.inbox'))('title') };
}

export default function Page() {
  return <InboxView />;
}
