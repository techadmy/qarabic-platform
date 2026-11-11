import { fromMinor, toMinor } from '@qarabic/shared';
import type { Prisma } from '../generated/prisma/client.js';

/** A `numeric(12,2)` column → integer minor units (exact: the decimal string is parsed). */
export function minor(value: Prisma.Decimal | null | undefined): number {
  return value === null || value === undefined ? 0 : toMinor(value.toFixed(2));
}

/** Integer minor units → the decimal string Prisma writes to a `numeric(12,2)` column. */
export const dec = (minorUnits: number): string => fromMinor(minorUnits);

/** A `numeric(12,2)` column → `"60.00"` for a DTO. */
export const amountOf = (value: Prisma.Decimal | null | undefined): string =>
  fromMinor(minor(value));
