import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { RoleEditor } from '../role-editor';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('roles'))('editor.newTitle') };
}

export default function NewRolePage() {
  return <RoleEditor />;
}
