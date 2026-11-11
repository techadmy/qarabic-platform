import { HttpStatus } from '@nestjs/common';
import { BILLING_ERROR_MESSAGES, type BillingErrorCode } from '@qarabic/shared';
import { ApiException } from '../common/errors.js';

/**
 * A billing refusal: `{ message, code, errors?, data? }` (Laravel throws a ValidationException on
 * the field, so the default is 422 with the message under `errors[field]`).
 */
export function billingError(
  code: BillingErrorCode,
  field: string | null,
  status: HttpStatus = HttpStatus.UNPROCESSABLE_ENTITY,
  data?: Record<string, unknown>,
): ApiException {
  const message = BILLING_ERROR_MESSAGES[code].en;
  return new ApiException(status, {
    message,
    code,
    ...(field ? { errors: { [field]: [message] } } : {}),
    ...(data ? { data } : {}),
  });
}
