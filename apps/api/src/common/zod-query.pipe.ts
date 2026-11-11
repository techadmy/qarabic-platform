import { Query } from '@nestjs/common';
import type { z } from 'zod';
import { ZodPipe } from './zod.pipe.js';

/** `@ZodQuery(schema) query: z.output<typeof schema>`: query params parsed by a shared zod schema (422 on failure). */
export const ZodQuery = (schema: z.ZodType): ParameterDecorator => Query(new ZodPipe(schema));
