/**
 * The path the app is served under (`NEXT_PUBLIC_BASE_PATH`, e.g. `/app` on api.qarabic.com,
 * N8 cut-over). Empty by default. `next/link` and the router add it themselves; plain asset URLs
 * (`next/image` string sources, the MSW worker) need it added by hand.
 */
export const BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH ?? '';
