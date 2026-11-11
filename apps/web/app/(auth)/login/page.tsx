import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { LoginForm } from '@/components/auth/login-form';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('auth'))('loginTitle') };
}

export default function LoginPage() {
  return <LoginForm />;
}
