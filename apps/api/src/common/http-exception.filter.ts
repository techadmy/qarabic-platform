import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { ApiError } from '@qarabic/shared';
import type { Response } from 'express';

const CODES: Partial<Record<number, string>> = {
  400: 'bad_request',
  401: 'unauthenticated',
  403: 'forbidden',
  404: 'not_found',
  405: 'method_not_allowed',
  413: 'payload_too_large',
  422: 'validation_failed',
  429: 'too_many_requests',
};

/** Every error leaves the API as `{ message, code, errors? }`; 5xx details stay in the logs. */
@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger('Exceptions');

  catch(exception: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();
    const { status, body } = this.toBody(exception);
    if (status >= 500) this.logger.error(exception);
    res.status(status).json(body);
  }

  private toBody(exception: unknown): { status: number; body: ApiError } {
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const raw = exception.getResponse();
      const code = CODES[status] ?? (status >= 500 ? 'server_error' : 'error');
      if (typeof raw === 'object' && raw !== null && 'code' in raw && 'message' in raw) {
        return { status, body: raw as ApiError };
      }
      const message =
        status >= 500 ? 'Server error.' : typeof raw === 'string' ? raw : exception.message;
      return { status, body: { message, code } };
    }
    // Malformed JSON and oversized bodies from the express body parser.
    const err = exception as { status?: number; type?: string } | null;
    if (err?.status && err.status >= 400 && err.status < 500) {
      return {
        status: err.status,
        body: { message: 'Bad request.', code: CODES[err.status] ?? 'bad_request' },
      };
    }
    return {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      body: { message: 'Server error.', code: 'server_error' },
    };
  }
}
