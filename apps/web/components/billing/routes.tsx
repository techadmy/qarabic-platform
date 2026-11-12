'use client';

import { useCurrentUser } from '@/components/shell/app-shell';
import { InvoiceDetailView } from './invoice-detail-view';
import { InvoicesView } from './invoices-view';
import { ParentInvoiceView, ParentInvoicesView } from './parent-invoices';

/** `/invoices`: «فواتيري» for a parent (mobile-first cards), the staff list for everyone else. */
export function InvoicesRoute() {
  const me = useCurrentUser();
  return me.role?.kind === 'parent' ? <ParentInvoicesView /> : <InvoicesView />;
}

/** `/invoices/:id`: the parent's invoice with «ادفع الآن», or the staff workbench. */
export function InvoiceRoute({ id }: { id: number }) {
  const me = useCurrentUser();
  return me.role?.kind === 'parent' ? <ParentInvoiceView id={id} /> : <InvoiceDetailView id={id} />;
}
