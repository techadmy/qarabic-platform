import { Body, type PipeTransform } from '@nestjs/common';
import type { z } from 'zod';
import { validationError } from './errors.js';

/** Parses with a zod schema (from `@qarabic/shared`); failures become a 422 `validation_failed`. */
export class ZodPipe<S extends z.ZodType> implements PipeTransform<unknown, z.output<S>> {
  constructor(private readonly schema: S) {}

  transform(value: unknown): z.output<S> {
    const result = this.schema.safeParse(value ?? {});
    if (result.success) return result.data;
    const errors: Record<string, string[]> = {};
    for (const issue of result.error.issues) {
      const key = issue.path.length ? issue.path.join('.') : '_';
      (errors[key] ??= []).push(issue.message);
    }
    throw validationError(errors);
  }
}

/** `@ZodBody(schema) body: z.output<typeof schema>` */
export const ZodBody = (schema: z.ZodType): ParameterDecorator => Body(new ZodPipe(schema));
