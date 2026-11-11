import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { server } from '@/mocks/node';
import { apiFetch, ApiError, readCookie } from './client';

describe('apiFetch', () => {
  it('fetches the CSRF cookie first and sends X-XSRF-TOKEN on unsafe methods', async () => {
    expect(readCookie('XSRF-TOKEN')).toBeNull();
    let header: string | null = null;
    server.use(
      http.post('*/api/v1/auth/forgot-password', ({ request }) => {
        header = request.headers.get('X-XSRF-TOKEN');
        return HttpResponse.json({ status: 'ok' });
      }),
    );
    await apiFetch('/auth/forgot-password', { method: 'POST', body: { email: 'a@b.co' } });
    expect(readCookie('XSRF-TOKEN')).toBe('mock-csrf-token');
    expect(header).toBe('mock-csrf-token');
  });

  it('does not send the CSRF header on GET', async () => {
    let header: string | null = 'unset';
    server.use(
      http.get('*/api/v1/auth/me', ({ request }) => {
        header = request.headers.get('X-XSRF-TOKEN');
        return HttpResponse.json({}, { status: 401 });
      }),
    );
    await expect(apiFetch('/auth/me')).rejects.toBeInstanceOf(ApiError);
    expect(header).toBeNull();
  });

  it('refreshes the token and retries once on 419', async () => {
    document.cookie = 'XSRF-TOKEN=stale; path=/';
    let calls = 0;
    server.use(
      http.post('*/api/v1/auth/logout', ({ request }) => {
        calls += 1;
        return request.headers.get('X-XSRF-TOKEN') === 'mock-csrf-token'
          ? new HttpResponse(null, { status: 204 })
          : HttpResponse.json({ message: 'CSRF token mismatch.' }, { status: 419 });
      }),
    );
    await apiFetch('/auth/logout', { method: 'POST' });
    expect(calls).toBe(2);
  });

  it('throws ApiError with the status and body', async () => {
    server.use(
      http.get('*/api/v1/roles', () => HttpResponse.json({ message: 'no' }, { status: 403 })),
    );
    await expect(apiFetch('/roles')).rejects.toMatchObject({
      status: 403,
      body: { message: 'no' },
    });
  });
});
