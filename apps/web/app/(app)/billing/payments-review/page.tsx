import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { PaymentsReviewView } from '@/components/billing/payments-review-view';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('billing.paymentsReview'))('title') };
}

export default function Page() {
  return <PaymentsReviewView />;
}
