/**
 * The way back from the payment provider (docs/20 §7.1, D88). The API sends the parent back to
 * `/invoices/:id?checkout=return&provider=stripe|paypal` (PayPal adds `token` = the order id) or
 * `?checkout=cancelled`; `success` / `cancel` are accepted too. The return address never marks
 * anything paid: it only tells the page to show «جارٍ تأكيد الدفع…» and poll the invoice.
 */
export type CheckoutReturn = {
  kind: 'none' | 'return' | 'cancelled';
  provider: 'stripe' | 'paypal' | null;
  /** PayPal's approved order to capture on the server (`token`), only on a PayPal return. */
  paypalOrder: string | null;
};

export function readCheckoutReturn(search: Pick<URLSearchParams, 'get'>): CheckoutReturn {
  const checkout = search.get('checkout');
  const kind =
    checkout === 'return' || checkout === 'success'
      ? 'return'
      : checkout === 'cancelled' || checkout === 'cancel'
        ? 'cancelled'
        : 'none';
  const raw = search.get('provider');
  const provider = raw === 'stripe' || raw === 'paypal' ? raw : null;
  const token = search.get('token');
  const paypalOrder =
    kind === 'return' && provider === 'paypal' && token && /^[A-Z0-9-]{1,64}$/.test(token)
      ? token
      : null;
  return { kind, provider, paypalOrder };
}

/**
 * Where «ادفع» sends the browser: the provider's hosted page (https only), or — only in mock mode,
 * where the "provider page" is the app's own return address — a path inside the app.
 */
export function checkoutTarget(
  url: string,
  origin: string,
): { kind: 'internal'; path: string } | { kind: 'external'; url: string } | { kind: 'invalid' } {
  let parsed: URL;
  try {
    parsed = new URL(url, origin);
  } catch {
    return { kind: 'invalid' };
  }
  if (parsed.origin === origin) return { kind: 'internal', path: parsed.pathname + parsed.search };
  if (parsed.protocol === 'https:') return { kind: 'external', url: parsed.toString() };
  return { kind: 'invalid' };
}
