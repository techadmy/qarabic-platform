'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { useState } from 'react';
import { HomeView } from '@/app/(app)/home-view';
import { ContactHub, type ContactDeepLink } from '@/components/support/contact-hub';

const id = (v: string | null) => {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : undefined;
};

/**
 * Where a deep link from WhatsApp lands (S5, docs/32): the person's own home with «تواصل معنا»
 * open on the card or choice the link names (pre-filled with its class, invoice or child). The
 * sign-in comes first when needed (the app layout keeps `next`). Closing returns to the home page.
 */
export function ContactRoute() {
  const router = useRouter();
  const params = useSearchParams();
  const [open, setOpen] = useState(true);
  const link: ContactDeepLink = {
    card: params.get('card') ?? undefined,
    choice: params.get('choice') ?? undefined,
    sessionId: id(params.get('session')),
    invoiceId: id(params.get('invoice')),
    studentId: id(params.get('student')),
  };
  const leave = () => {
    setOpen(false);
    router.replace('/');
  };
  return (
    <>
      <HomeView />
      <ContactHub
        open={open}
        onOpenChange={(o) => (o ? setOpen(true) : leave())}
        // A technical report needs a screenshot of a real page: send them home, where the top bar's
        // «تواصل معنا» takes it.
        onReport={leave}
        initial={link}
      />
    </>
  );
}
