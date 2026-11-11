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
        return HttpResponse.json({ message: 'ok' });
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
        return HttpResponse.json(
          { message: 'Unauthenticated.', code: 'unauthenticated' },
          { status: 401 },
        );
      }),
    );
    await expect(apiFetch('/auth/me')).rejects.toBeInstanceOf(ApiError);
    expect(header).toBeNull();
  });

  it('refreshes the token and retries once on 403 csrf_mismatch', async () => {
    document.cookie = 'XSRF-TOKEN=stale; path=/';
    let calls = 0;
    server.use(
      http.post('*/api/v1/auth/logout', ({ request }) => {
        calls += 1;
        return request.headers.get('X-XSRF-TOKEN') === 'mock-csrf-token'
          ? new HttpResponse(null, { status: 204 })
          : HttpResponse.json(
              { message: 'CSRF token mismatch.', code: 'csrf_mismatch' },
              { status: 403 },
            );
      }),
    );
    await apiFetch('/auth/logout', { method: 'POST' });
    expect(calls).toBe(2);
  });

  it('does not retry other 403 answers', async () => {
    document.cookie = 'XSRF-TOKEN=mock-csrf-token; path=/';
    let calls = 0;
    server.use(
      http.post('*/api/v1/auth/logout', () => {
        calls += 1;
        return HttpResponse.json({ message: 'Forbidden.', code: 'forbidden' }, { status: 403 });
      }),
    );
    await expect(apiFetch('/auth/logout', { method: 'POST' })).rejects.toMatchObject({
      status: 403,
      code: 'forbidden',
    });
    expect(calls).toBe(1);
  });

  it('throws ApiError with the status and the standard error body', async () => {
    server.use(
      http.get('*/api/v1/roles', () =>
        HttpResponse.json(
          { message: 'Invalid.', code: 'validation_failed', errors: { name: ['Required.'] } },
          { status: 422 },
        ),
      ),
    );
    const error = await apiFetch('/roles').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({
      status: 422,
      code: 'validation_failed',
      error: { errors: { name: ['Required.'] } },
    });
  });
});
