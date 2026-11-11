import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { RoleEditor } from '../role-editor';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('roles'))('editor.title') };
}

export default async function RolePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <RoleEditor id={Number(id)} />;
}
