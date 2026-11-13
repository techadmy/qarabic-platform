import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { ContactRoute } from './contact-route';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('support.contact'))('title') };
}

/** `/contact?card=…&choice=…&session|invoice|student=…`: the S5 deep links (WhatsApp off-ramp). */
export default function ContactPage() {
  return <ContactRoute />;
}
