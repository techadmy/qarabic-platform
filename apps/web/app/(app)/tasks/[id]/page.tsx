import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { TaskView } from '@/components/operations/task-view';
import { routeId } from '@/lib/operations/time';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('operations.tasks'))('detailTitle') };
}

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const id = routeId((await params).id);
  if (id === null) notFound();
  return <TaskView id={id} />;
}
