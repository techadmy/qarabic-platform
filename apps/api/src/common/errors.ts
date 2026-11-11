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
