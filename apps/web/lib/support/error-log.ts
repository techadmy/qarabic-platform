/**
 * The last failed API calls (at most 10), sent with a technical report so the team can find the
 * server log line (docs/22 §5.1): method, path without the query string, status and request id.
 * Never a body or a query string. Failures of the report endpoints themselves are left out.
 */
const MAX = 10;

export interface ApiErrorEntry {
  method: string;
  path: string;
  status?: number;
  requestId?: string;
  at: string;
}

let entries: ApiErrorEntry[] = [];

export function recordApiError(e: {
  method?: string;
  path?: string;
  status?: number;
  requestId?: string | null;
}) {
  const path = (e.path ?? '').split('?')[0] ?? '';
  if (path.startsWith('/feedback/')) return;
  entries = [
    ...entries,
    {
      method: (e.method ?? 'GET').toUpperCase(),
      path,
      status: e.status,
      ...(e.requestId ? { requestId: e.requestId } : {}),
      at: new Date().toISOString(),
    },
  ].slice(-MAX);
}

export function recentApiErrors(): ApiErrorEntry[] {
  return [...entries];
}

export function clearApiErrors() {
  entries = [];
}
