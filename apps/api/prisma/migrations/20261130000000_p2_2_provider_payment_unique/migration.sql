-- BIL-11 (docs/39 P2-2): a provider's payment id (Stripe payment_intent / PayPal capture id) names
-- one payment, so a refund can never hit an arbitrary row.
CREATE UNIQUE INDEX "payments_method_provider_payment_id_key" ON "payments"("method", "provider_payment_id")
  WHERE "provider_payment_id" IS NOT NULL;
