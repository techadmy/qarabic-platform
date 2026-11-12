/** Rules of the accounting periods screen (M7), kept out of the component and unit tested. */

/** The currency a report or statement opens in when none is chosen. */
export const DEFAULT_CURRENCY = 'USD';
/** The start of an "everything up to" range (balance-sheet accounts opening their statement). */
export const STATEMENT_START = '2000-01-01';
/** Years the periods screen can show. */
export const FIRST_YEAR = 2000;

/** `YYYY-MM` of an academy date key. */
export const periodOfDay = (day: string) => day.slice(0, 7);

/** A month can be closed once it has ended (the API refuses a running or future month). */
export const hasEnded = (period: string, today: string) => period < periodOfDay(today);

/** The year shown: the URL's when it is a sensible year, else the current one. */
export function shownYear(raw: string, today: string): number {
  const current = Number(today.slice(0, 4));
  const y = Number(raw);
  return Number.isInteger(y) && y >= FIRST_YEAR && y <= current ? y : current;
}
