import type { HttpStatus } from '@nestjs/common';
import { PAYROLL_ERROR_MESSAGES, type PayrollErrorCode } from '@qarabic/shared';
import { ApiException } from '../common/errors.js';

/** A payroll refusal with its message (Laravel `PayrollError`, `lang/en/payroll.php`). */
export function payrollError(
  status: HttpStatus,
  code: PayrollErrorCode,
  extra: { errors?: Record<string, string[]>; data?: unknown } = {},
): ApiException {
  return new ApiException(status, {
    message: PAYROLL_ERROR_MESSAGES[code].en,
    code,
    ...(extra.errors ? { errors: extra.errors } : {}),
    ...(extra.data !== undefined ? { data: extra.data as Record<string, unknown> } : {}),
  });
}
