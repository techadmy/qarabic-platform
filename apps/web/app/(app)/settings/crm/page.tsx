import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { CrmSettingsView } from '@/components/crm/crm-settings-view';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('crm.settings'))('title') };
}

export default function Page() {
  return <CrmSettingsView />;
}
