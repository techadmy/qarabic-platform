import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { MyClassesView } from './my-classes-view';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('myClasses'))('pageTitle') };
}

export default function Page() {
  return <MyClassesView />;
}
