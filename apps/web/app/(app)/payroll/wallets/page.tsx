import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { WalletsView } from '@/components/payroll/wallet-views';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('payroll.wallets'))('title') };
}

export default function Page() {
  return <WalletsView />;
}
