import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { SessionSettingsView } from './session-settings-view';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('sessionSettings'))('title') };
}

export default function Page() {
  return <SessionSettingsView />;
}
