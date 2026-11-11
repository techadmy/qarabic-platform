import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { RolesView } from './roles-view';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('roles'))('title') };
}

export default function RolesPage() {
  return <RolesView />;
}
