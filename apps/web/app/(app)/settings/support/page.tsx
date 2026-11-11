import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { SupportSettingsView } from '@/components/support/support-settings-view';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('support.settings'))('title') };
}

export default function Page() {
  return <SupportSettingsView />;
}
