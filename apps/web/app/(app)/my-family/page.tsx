import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { MyFamilyView } from './my-family-view';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('nav'))('myFamily') };
}

export default function MyFamilyPage() {
  return <MyFamilyView />;
}
