'use client';

import { useQuery } from '@tanstack/react-query';
import { useRouter, useSearchParams } from 'next/navigation';
import { useState } from 'react';
import { HomeView } from '@/app/(app)/home-view';
import { ContactHub, type ContactDeepLink } from '@/components/support/contact-hub';
import { fetchInvoice } from '@/lib/api/billing';
import { fetchPerson } from '@/lib/api/people';

const id = (v: string | null) => {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : undefined;
};

/**
 * Where a deep link from WhatsApp lands (S5, docs/32): the person's own home with «تواصل معنا»
 * open on the card or choice the link names. An invoice or child in the link is looked up first,
 * as this person: its number or name becomes the form's subject; one that isn't theirs (403/404)
 * or doesn't load is dropped, and the form opens without it. The sign-in comes first when needed
 * (the app layout keeps `next`). Closing returns to the home page.
 */
export function ContactRoute() {
  const router = useRouter();
  const params = useSearchParams();
  const [open, setOpen] = useState(true);
  const invoiceId = id(params.get('invoice'));
  const studentId = id(params.get('student'));
  const invoice = useQuery({
    queryKey: ['contact', 'invoice', invoiceId],
    queryFn: ({ signal }) => fetchInvoice(invoiceId!, signal),
    enabled: !!invoiceId,
    retry: false,
  });
  const student = useQuery({
    queryKey: ['contact', 'student', studentId],
    queryFn: ({ signal }) => fetchPerson('students', studentId!, signal),
    enabled: !!studentId && !invoiceId,
    retry: false,
  });
  const looking =
    (!!invoiceId && invoice.isPending) || (!!studentId && !invoiceId && student.isPending);
  const subjectLabel = invoice.data
    ? (invoice.data.number ?? `#${invoice.data.id}`)
    : student.data
      ? student.data.name
      : undefined;
  const link: ContactDeepLink = {
    card: params.get('card') ?? undefined,
    choice: params.get('choice') ?? undefined,
    sessionId: id(params.get('session')),
    invoiceId: invoice.data ? invoiceId : undefined,
    studentId: student.data ? studentId : undefined,
    subjectLabel,
  };
  const leave = () => {
    setOpen(false);
    router.replace('/');
  };
  return (
    <>
      <HomeView />
      {/* Opens once the subject is known (or dropped): the hub reads the link only on mount. */}
      {!looking && (
        <ContactHub
          open={open}
          onOpenChange={(o) => (o ? setOpen(true) : leave())}
          // A technical report needs a screenshot of a real page: send them home, where the top
          // bar's «تواصل معنا» takes it.
          onReport={leave}
          initial={link}
        />
      )}
    </>
  );
}
