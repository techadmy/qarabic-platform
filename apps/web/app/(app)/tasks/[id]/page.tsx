import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { TaskView } from '@/components/operations/task-view';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('operations.tasks'))('detailTitle') };
}

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <TaskView id={Number(id)} />;
}
