import { HttpStatus } from '@nestjs/common';
import { OPERATIONS_ERROR_MESSAGES, type OperationsErrorCode } from '@qarabic/shared';
import { ApiException } from '../common/errors.js';

export function opsError(
  code: OperationsErrorCode,
  status: HttpStatus = HttpStatus.CONFLICT,
  field?: string,
): ApiException {
  const message = OPERATIONS_ERROR_MESSAGES[code].en;
  return new ApiException(status, {
    message,
    code,
    ...(field ? { errors: { [field]: [message] } } : {}),
  });
}
