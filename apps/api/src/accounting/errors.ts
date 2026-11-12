import { HttpStatus } from '@nestjs/common';
import { ACCOUNTING_ERROR_MESSAGES, type AccountingErrorCode } from '@qarabic/shared';
import { ApiException } from '../common/errors.js';

/** An accounting refusal `{ message, code, errors? }` (messages in `@qarabic/shared`). */
export function accountingError(
  code: AccountingErrorCode,
  status: HttpStatus = HttpStatus.UNPROCESSABLE_ENTITY,
  field?: string,
): ApiException {
  const message = ACCOUNTING_ERROR_MESSAGES[code].en;
  return new ApiException(status, {
    message,
    code,
    ...(field ? { errors: { [field]: [message] } } : {}),
  });
}
