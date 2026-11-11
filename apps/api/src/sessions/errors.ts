import { HttpStatus } from '@nestjs/common';
import { ApiException, validationError } from '../common/errors.js';

/** Messages of the class / schedule refusals (Laravel `lang/en/api.php`, `conflicts.php`). */
const MESSAGES = {
  invalid_transition: 'This action is not possible for the class in its current state.',
  outside_window: 'This action is not available at this time.',
  stale_session: 'The class was changed by someone else. Here is the latest version.',
  forbidden: 'You do not have permission to do this.',
  zoom_unavailable: 'The meeting link is not available.',
  conflict: 'This cannot be done in the current state.',
  schedule_conflict: 'The time conflicts with the schedule.',
  warnings_not_acknowledged: 'Please confirm the warnings to continue.',
} as const;
export type SessionErrorCode = keyof typeof MESSAGES;

export function fail(
  status: HttpStatus,
  code: SessionErrorCode,
  extra: { errors?: Record<string, unknown>; data?: unknown; message?: string } = {},
): ApiException {
  return new ApiException(status, {
    message: extra.message ?? MESSAGES[code],
    code,
    ...(extra.errors ? { errors: extra.errors as Record<string, string[]> } : {}),
    ...(extra.data !== undefined ? { data: extra.data as Record<string, unknown> } : {}),
  });
}

export const invalidTransition = (errors?: Record<string, string[]>) =>
  fail(HttpStatus.CONFLICT, 'invalid_transition', errors ? { errors } : {});

export const outsideWindow = (errors?: Record<string, string[]>) =>
  fail(HttpStatus.UNPROCESSABLE_ENTITY, 'outside_window', errors ? { errors } : {});

export const forbiddenAction = () => fail(HttpStatus.FORBIDDEN, 'forbidden');

export const conflictState = (errors?: Record<string, string[]>) =>
  fail(HttpStatus.CONFLICT, 'conflict', errors ? { errors } : {});

export const required = (field: string) =>
  validationError({ [field]: [`The ${field} field is required.`] });

export const invalidField = (field: string, message = `The selected ${field} is invalid.`) =>
  validationError({ [field]: [message] });
