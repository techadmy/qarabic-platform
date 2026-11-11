import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { ForgotPasswordForm } from '@/components/auth/forgot-password-form';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('auth'))('forgotTitle') };
}

export default function ForgotPasswordPage() {
  return <ForgotPasswordForm />;
}
