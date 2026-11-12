import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { TasksView } from '@/components/operations/tasks-view';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('operations.tasks'))('title') };
}

export default function Page() {
  return <TasksView />;
}
