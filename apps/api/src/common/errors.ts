import { HttpException, HttpStatus } from '@nestjs/common';
import type { ApiError } from '@qarabic/shared';

/** Throws the standard error body `{ message, code, errors? }`. */
export class ApiException extends HttpException {
  constructor(status: HttpStatus, body: ApiError) {
    super(body, status);
  }
}

export function validationError(
  errors: Record<string, string[]>,
  message = 'The given data was invalid.',
  code = 'validation_failed',
): ApiException {
  return new ApiException(HttpStatus.UNPROCESSABLE_ENTITY, { message, code, errors });
}

export function notFound(message = 'Not found.'): ApiException {
  return new ApiException(HttpStatus.NOT_FOUND, { message, code: 'not_found' });
}

/** Messages of the business-rule refusals (same codes as the Laravel API, `lang/en/api.php`). */
export const RULE_MESSAGES = {
  archived: 'This record is deleted (archived). Restore it before changing it.',
  not_archived: 'This record is not archived.',
  must_deactivate_first: 'Change the status to inactive / deactivated before deleting.',
  family_archived: 'The family is deleted (archived). Restore the family first.',
  same_status: 'The record already has this status.',
  teacher_has_students:
    'This teacher still has active students or enrollments. Move them to another teacher first.',
  cannot_archive_self: 'You cannot delete or deactivate your own account.',
  cannot_change_own_role: 'You cannot change your own role.',
  last_admin: 'This is the last active owner account.',
  role_in_use: 'This role is assigned to users. Move them to another role first.',
  system_role:
    'This is a system role: it cannot be deleted, and portal roles keep their permissions.',
  owner_role_locked:
    'The owner role always has every permission; only an owner can change or assign it.',
  cannot_edit_own_role: 'You cannot change or delete your own role.',
  permission_not_held: 'You cannot grant a permission you do not have.',
  wrong_password: 'The current password is not correct.',
} as const;
export type RuleCode = keyof typeof RULE_MESSAGES;

/** A business-rule refusal: `{ message, code, errors?, data? }` with the given status. */
export function rule(
  status: HttpStatus,
  code: RuleCode,
  extra: { errors?: Record<string, string[]>; data?: Record<string, unknown> } = {},
): ApiException {
  return new ApiException(status, { message: RULE_MESSAGES[code], code, ...extra });
}

export const conflict = (code: RuleCode, data?: Record<string, unknown>) =>
  rule(HttpStatus.CONFLICT, code, data ? { data } : {});
