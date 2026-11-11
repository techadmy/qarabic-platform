import { formatMoney, fromMinor, invoicePath } from '@qarabic/shared';

export type InvoiceMailKind = 'issued' | 'reminder';

const STRINGS = {
  en: {
    subject_issued: (n: string) => `Qarabic invoice ${n}`,
    subject_reminder: (n: string) => `Payment reminder: invoice ${n}`,
    greeting: 'Assalamu alaikum,',
    intro_issued: (n: string) => `Your invoice ${n} is ready.`,
    intro_reminder: (n: string) => `This is a reminder that invoice ${n} is still due.`,
    amount: 'Amount due',
    due: 'Due date',
    button: 'View and pay the invoice',
    signature: 'Kind regards, Qarabic Academy',
    footer:
      'You receive this email because you are registered with Qarabic Academy. Sign in to the ' +
      'parent portal to pay; we never ask for your password by email.',
  },
  ar: {
    subject_issued: (n: string) => `فاتورة أكاديمية قرآبيك ${n}`,
    subject_reminder: (n: string) => `تذكير بالدفع: الفاتورة ${n}`,
    greeting: 'السلام عليكم ورحمة الله،',
    intro_issued: (n: string) => `فاتورتكم رقم ${n} جاهزة.`,
    intro_reminder: (n: string) => `نذكّركم بأن الفاتورة رقم ${n} ما زالت مستحقة.`,
    amount: 'المبلغ المستحق',
    due: 'تاريخ الاستحقاق',
    button: 'عرض الفاتورة ودفعها',
    signature: 'مع التحية، أكاديمية قرآبيك',
    footer:
      'تصلكم هذه الرسالة لأنكم مسجلون في أكاديمية قرآبيك. سجّلوا الدخول إلى بوابة ولي الأمر ' +
      'للدفع؛ لن نطلب كلمة المرور بالبريد أبدًا.',
  },
} as const;

/**
 * Invoice issued / payment reminder (Laravel `InvoiceMail`, D88): the parent's language first, then
 * the other one, and a link to the invoice in the portal. Never a password or a pay-without-login
 * link.
 */
export function invoiceMail(
  invoice: {
    id: number;
    number: string | null;
    currency: string;
    balanceMinor: number;
    dueDate: string | null;
  },
  kind: InvoiceMailKind,
  locale: 'ar' | 'en',
  appUrl: string,
): { subject: string; text: string } {
  const number = invoice.number ?? '';
  const amount = formatMoney(fromMinor(invoice.balanceMinor), invoice.currency);
  const url = `${appUrl.replace(/\/+$/, '')}${invoicePath(invoice.id)}`;
  const block = (l: 'ar' | 'en') => {
    const s = STRINGS[l];
    return [
      s.greeting,
      '',
      kind === 'issued' ? s.intro_issued(number) : s.intro_reminder(number),
      `${s.amount}: ${amount}`,
      `${s.due}: ${invoice.dueDate ?? '—'}`,
      '',
      `${s.button}: ${url}`,
      '',
      s.signature,
      s.footer,
    ].join('\n');
  };
  const order: Array<'ar' | 'en'> = locale === 'en' ? ['en', 'ar'] : ['ar', 'en'];
  const s = STRINGS[locale];
  return {
    subject: kind === 'issued' ? s.subject_issued(number) : s.subject_reminder(number),
    text: order.map(block).join('\n\n— — —\n\n'),
  };
}
