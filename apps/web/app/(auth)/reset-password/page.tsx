import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { ResetPasswordForm } from '@/components/auth/reset-password-form';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('auth'))('resetTitle') };
}

/** The reset link from the email: `/reset-password?token=…&email=…`. */
export default async function ResetPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string; email?: string }>;
}) {
  const { token = '', email = '' } = await searchParams;
  return <ResetPasswordForm token={token} email={email} />;
}
