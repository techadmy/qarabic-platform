import { HttpStatus } from '@nestjs/common';
import { ApiException } from '../common/errors.js';

/** Messages of the CRM refusals (Laravel `lang/en/crm.php`, `api.php`). */
const MESSAGES = {
  invalid_transition: 'This action is not possible for the lead in its current state.',
  forbidden: 'You do not have permission to do this.',
  already_has_family: 'This lead already has a family account.',
  email_taken: 'This email already has an account. Link the lead to that family instead.',
  no_family: 'Create the family account first.',
  already_enrolled: 'The student is already enrolled in this course.',
  range_too_long: 'Choose a period of at most one year.',
  unknown_form: 'Unknown form.',
  invalid_signature: 'Invalid signature.',
  webhook_disabled: 'Webhook disabled.',
  captcha_failed: 'The captcha check failed. Please try again.',
  too_many_requests: 'Too many attempts. Please try again later.',
} as const;
export type CrmErrorCode = keyof typeof MESSAGES;

export function crmError(
  status: HttpStatus,
  code: CrmErrorCode,
  extra: { errors?: Record<string, string[]>; data?: Record<string, unknown> } = {},
): ApiException {
  return new ApiException(status, { message: MESSAGES[code], code, ...extra });
}

export const leadTransition = () => crmError(HttpStatus.UNPROCESSABLE_ENTITY, 'invalid_transition');
export const leadForbidden = () => crmError(HttpStatus.FORBIDDEN, 'forbidden');
