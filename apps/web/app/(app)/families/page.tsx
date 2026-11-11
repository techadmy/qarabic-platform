import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { FamiliesView } from './families-view';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('families'))('title') };
}

export default function FamiliesPage() {
  return <FamiliesView />;
}
