import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { Suspense } from 'react';
import { PublicTrialForm } from '@/components/crm/public-trial-form';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('trialForm'))('title') };
}

/** The public free-trial form: no login (docs/33 §3.1). */
export default function Page() {
  return (
    <Suspense>
      <PublicTrialForm />
    </Suspense>
  );
}
