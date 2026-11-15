-- D1 (docs/40, D144 / B124): monthly exchange rates to USD, kept by accounts.
CREATE TABLE "exchange_rates" (
    "id" SERIAL NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "month" CHAR(7) NOT NULL,
    "rate_to_usd" DECIMAL(18,8) NOT NULL,
    "note" VARCHAR(500),
    "updated_by" INTEGER,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "exchange_rates_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "exchange_rates_rate_positive" CHECK ("rate_to_usd" > 0),
    CONSTRAINT "exchange_rates_not_usd" CHECK ("currency" <> 'USD'),
    CONSTRAINT "exchange_rates_month_format" CHECK ("month" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$')
);

CREATE UNIQUE INDEX "exchange_rates_currency_month_key" ON "exchange_rates"("currency", "month");
