/** Database names the importer may write to without the production flag (docs/34 §5, N8). */
export const SAFE_SUFFIXES = ['_rehearsal', '_dev', '_test'] as const;

/** The database name of a Postgres URL (no host, user or password). */
export function databaseName(url: string): string {
  try {
    return decodeURIComponent(new URL(url).pathname.replace(/^\//, ''));
  } catch {
    return '';
  }
}

/**
 * Refuses a target whose database name does not end in `_rehearsal`, `_dev` or `_test` unless
 * `--i-know-this-is-production` was passed. The message names the database only.
 */
export function checkTarget(
  url: string,
  productionFlag: boolean,
): { ok: true } | { ok: false; message: string } {
  const name = databaseName(url);
  if (!name) return { ok: false, message: 'DATABASE_URL is not a valid Postgres URL.' };
  if (SAFE_SUFFIXES.some((s) => name.endsWith(s)) || productionFlag) return { ok: true };
  return {
    ok: false,
    message:
      `Refusing to write to database "${name}": its name does not end in ${SAFE_SUFFIXES.join(', ')}. ` +
      'Pass --i-know-this-is-production only during the announced cut-over.',
  };
}
