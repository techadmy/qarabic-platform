import {
  INVOICE_LINE_TYPE_LABELS,
  INVOICE_STATUS_LABELS,
  type InvoiceDetailDto,
  PAYMENT_METHOD_LABELS,
} from '@qarabic/shared';

const esc = (v: string | number | null | undefined) =>
  String(v ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );

const T = {
  ar: {
    title: 'فاتورة',
    academy: 'أكاديمية قرآبيك',
    family: 'الأسرة',
    status: 'الحالة',
    issueDate: 'تاريخ الإصدار',
    dueDate: 'تاريخ الاستحقاق',
    period: 'الفترة',
    item: 'البند',
    type: 'النوع',
    amount: 'المبلغ',
    subtotal: 'المجموع الفرعي',
    adjustments: 'التسويات',
    discounts: 'الخصومات',
    total: 'الإجمالي',
    paid: 'المدفوع',
    balance: 'الرصيد المستحق',
    payments: 'المدفوعات',
    receipt: 'رقم الإيصال',
    method: 'الطريقة',
    date: 'التاريخ',
    draft: 'مسودة — ليست فاتورة صادرة',
  },
  en: {
    title: 'Invoice',
    academy: 'Qarabic Academy',
    family: 'Family',
    status: 'Status',
    issueDate: 'Issue date',
    dueDate: 'Due date',
    period: 'Period',
    item: 'Item',
    type: 'Type',
    amount: 'Amount',
    subtotal: 'Subtotal',
    adjustments: 'Adjustments',
    discounts: 'Discounts',
    total: 'Total',
    paid: 'Paid',
    balance: 'Balance due',
    payments: 'Payments',
    receipt: 'Receipt',
    method: 'Method',
    date: 'Date',
    draft: 'Draft — not an issued invoice',
  },
} as const;

/**
 * The printable invoice (Laravel has no PDF): a self-contained HTML page in the viewer's language
 * that the browser prints or saves as PDF. No scripts, no external resources; every value escaped.
 */
export function invoiceHtml(i: InvoiceDetailDto, locale: 'ar' | 'en'): string {
  const t = T[locale];
  const money = (v: string) => `${esc(v)} ${esc(i.currency)}`;
  const succeeded = i.payments.filter((p) => p.status === 'succeeded');
  return `<!doctype html>
<html lang="${locale}" dir="${locale === 'ar' ? 'rtl' : 'ltr'}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(t.title)} ${esc(i.number ?? '')}</title>
<style>
  body { font-family: "IBM Plex Sans Arabic", Inter, system-ui, sans-serif; color: #111; margin: 32px; font-size: 14px; }
  h1 { font-size: 22px; margin: 0 0 4px; }
  .muted { color: #555; }
  table { width: 100%; border-collapse: collapse; margin-top: 16px; }
  th, td { border-bottom: 1px solid #ddd; padding: 8px; text-align: start; }
  td.num, th.num { text-align: end; font-variant-numeric: tabular-nums; white-space: nowrap; }
  .totals td { border: none; padding: 4px 8px; }
  .totals tr.strong td { font-weight: 700; font-size: 16px; }
  .draft { color: #b45309; font-weight: 600; }
  @media print { body { margin: 0; } }
</style>
</head>
<body>
<h1>${esc(t.title)} ${esc(i.number ?? '')}</h1>
<div class="muted">${esc(t.academy)}</div>
${i.status === 'draft' ? `<p class="draft">${esc(t.draft)}</p>` : ''}
<table>
  <tr><th>${esc(t.family)}</th><td>${esc(i.family.name)}</td></tr>
  <tr><th>${esc(t.status)}</th><td>${esc(INVOICE_STATUS_LABELS[i.status][locale])}</td></tr>
  <tr><th>${esc(t.issueDate)}</th><td>${esc(i.issueDate ?? '—')}</td></tr>
  <tr><th>${esc(t.dueDate)}</th><td>${esc(i.dueDate ?? '—')}</td></tr>
  ${i.periodStart ? `<tr><th>${esc(t.period)}</th><td>${esc(i.periodStart)} – ${esc(i.periodEnd ?? '')}</td></tr>` : ''}
</table>
<table>
  <thead><tr><th>${esc(t.item)}</th><th>${esc(t.type)}</th><th class="num">${esc(t.amount)}</th></tr></thead>
  <tbody>
  ${i.lines
    .map(
      (l) =>
        `<tr><td>${esc(l.description)}</td><td>${esc(INVOICE_LINE_TYPE_LABELS[l.type][locale])}</td><td class="num">${money(l.amount)}</td></tr>`,
    )
    .join('\n  ')}
  </tbody>
</table>
<table class="totals">
  <tr><td>${esc(t.subtotal)}</td><td class="num">${money(i.subtotal)}</td></tr>
  ${i.adjustments !== '0.00' ? `<tr><td>${esc(t.adjustments)}</td><td class="num">${money(i.adjustments)}</td></tr>` : ''}
  ${i.discounts !== '0.00' ? `<tr><td>${esc(t.discounts)}</td><td class="num">${money(i.discounts)}</td></tr>` : ''}
  <tr class="strong"><td>${esc(t.total)}</td><td class="num">${money(i.total)}</td></tr>
  <tr><td>${esc(t.paid)}</td><td class="num">${money(i.paid)}</td></tr>
  <tr class="strong"><td>${esc(t.balance)}</td><td class="num">${money(i.balance)}</td></tr>
</table>
${
  succeeded.length
    ? `<h2>${esc(t.payments)}</h2>
<table>
  <thead><tr><th>${esc(t.receipt)}</th><th>${esc(t.method)}</th><th>${esc(t.date)}</th><th class="num">${esc(t.amount)}</th></tr></thead>
  <tbody>
  ${succeeded
    .map(
      (p) =>
        `<tr><td>${esc(p.receiptNumber)}</td><td>${esc(PAYMENT_METHOD_LABELS[p.method][locale])}</td><td>${esc((p.receivedAt ?? '').slice(0, 10))}</td><td class="num">${money(p.amount)}</td></tr>`,
    )
    .join('\n  ')}
  </tbody>
</table>`
    : ''
}
</body>
</html>
`;
}
