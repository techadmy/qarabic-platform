import type { ApiBody } from '@nestjs/swagger';
import { z } from 'zod';

type BodySchema = NonNullable<
  Extract<Parameters<typeof ApiBody>[0], { schema?: unknown }>['schema']
>;

/** OpenAPI schema for a request body, generated from the shared zod schema (one source of truth). */
export function jsonSchema(schema: z.ZodType): BodySchema {
  const json: Record<string, unknown> = z.toJSONSchema(schema, {
    io: 'input',
    unrepresentable: 'any',
  });
  delete json.$schema;
  return json;
}
