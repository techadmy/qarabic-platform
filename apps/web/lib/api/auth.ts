import { meSchema, type Me } from '@qarabic/shared';
import { apiFetch, isApiError } from './client';

export type LoginPayload = { email: string; password: string; remember: boolean };
export type ResetPasswordPayload = {
  token: string;
  email: string;
  password: string;
  password_confirmation: string;
};

/** The signed-in user, or `null` when there is no session (401). */
export async function fetchMe(signal?: AbortSignal): Promise<Me | null> {
  try {
    return await apiFetch('/auth/me', { schema: meSchema, signal });
  } catch (error) {
    if (isApiError(error, 401)) return null;
    throw error;
  }
}

export function login(payload: LoginPayload): Promise<Me> {
  return apiFetch('/auth/login', { method: 'POST', body: payload, schema: meSchema });
}

export async function logout(): Promise<void> {
  await apiFetch('/auth/logout', { method: 'POST' });
}

export async function forgotPassword(email: string): Promise<void> {
  await apiFetch('/auth/forgot-password', { method: 'POST', body: { email } });
}

export async function resetPassword(payload: ResetPasswordPayload): Promise<void> {
  await apiFetch('/auth/reset-password', { method: 'POST', body: payload });
}
