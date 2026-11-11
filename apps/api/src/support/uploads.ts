import { TICKET_UPLOAD_LIMITS } from '@qarabic/shared';
import { AnyFilesInterceptor } from '@nestjs/platform-express';
import { validationError } from '../common/errors.js';
import { cleanFileName, sniffImage } from './storage.js';
import type { UploadedFile } from './tickets.service.js';

/** The multer file shape we read (memory storage). */
export interface MulterFile {
  fieldname: string;
  originalname: string;
  mimetype: string;
  size: number;
  buffer: Buffer;
}

/**
 * Multipart parsing in memory. The hard cap (6 MiB a file, 12 files) only protects the process
 * (413 above it); the real rules are checked by `readImages` as 422 errors per field.
 */
export const TicketFiles = () =>
  AnyFilesInterceptor({ limits: { fileSize: 6 * 1024 * 1024, files: 12, fields: 40 } });

/**
 * Images only (D102), checked from the bytes: PNG, JPEG or WebP up to 5 MB; `screenshot` (one,
 * where allowed) and up to 3 `attachments`. Anything else is a 422 on its field.
 */
export function readImages(
  files: MulterFile[] | undefined,
  allowScreenshot: boolean,
): UploadedFile[] {
  const list = files ?? [];
  const errors: Record<string, string[]> = {};
  const fields = allowScreenshot
    ? ['screenshot', 'attachments', 'attachments[]']
    : ['attachments', 'attachments[]'];
  for (const f of list) {
    if (!fields.includes(f.fieldname)) errors[f.fieldname] = ['This file field is not accepted.'];
  }
  const shots = list.filter((f) => f.fieldname === 'screenshot');
  const attachments = list.filter((f) => f.fieldname.startsWith('attachments'));
  if (shots.length > 1) errors.screenshot = ['Send one screenshot.'];
  if (attachments.length > TICKET_UPLOAD_LIMITS.maxImagesPerRequest) {
    errors.attachments = [
      `Send at most ${TICKET_UPLOAD_LIMITS.maxImagesPerRequest} images at a time.`,
    ];
  }
  const out: UploadedFile[] = [];
  const check = (f: MulterFile, key: string, source: 'screenshot' | 'upload') => {
    const mime = sniffImage(f.buffer);
    if (!mime) {
      errors[key] = ['The file must be a PNG, JPEG or WebP image.'];
    } else if (f.buffer.length > TICKET_UPLOAD_LIMITS.maxImageBytes) {
      errors[key] = ['The image may not be larger than 5 MB.'];
    } else {
      out.push({ bytes: f.buffer, mime, originalName: cleanFileName(f.originalname), source });
    }
  };
  if (shots[0]) check(shots[0], 'screenshot', 'screenshot');
  attachments.forEach((f, i) => check(f, `attachments.${i}`, 'upload'));
  if (Object.keys(errors).length) throw validationError(errors);
  return out;
}
