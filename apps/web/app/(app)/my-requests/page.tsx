import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { MyRequestsView } from '@/components/support/my-requests-view';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('support.mine'))('title') };
}

export default function Page() {
  return <MyRequestsView />;
}
