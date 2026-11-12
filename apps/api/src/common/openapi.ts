import type { INestApplication } from '@nestjs/common';
import { type ApiBody, DocumentBuilder, type OpenAPIObject, SwaggerModule } from '@nestjs/swagger';
import { auditRoutes } from './route-audit.js';
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

/** `GET /users/:id` → `/api/v1/users/{id}` (OpenAPI path form). */
export function openApiPath(route: string, prefix = 'api/v1'): string {
  const path = route.startsWith('api/') ? route : `${prefix}/${route}`;
  return `/${path.replace(/:([A-Za-z0-9_]+)/g, '{$1}')}`.replace(/\/+$/, '') || '/';
}

/**
 * The whole API as OpenAPI 3 (docs/17 §5): every route, its request body (from the shared zod
 * schemas) and who may call it (`x-access`: public / authenticated / permission, `x-permissions`).
 * Served at `/api/docs` outside production and written by `cli openapi:export`.
 */
export function buildOpenApiDocument(app: INestApplication): OpenAPIObject {
  const config = new DocumentBuilder()
    .setTitle('Qarabic API')
    .setDescription(
      'Versioned under /api/v1. Cookie session + CSRF header (X-XSRF-TOKEN) for writes. ' +
        'Errors: { message, code, errors? }. Money is a decimal string with its currency; ' +
        'instants are ISO UTC; dates are YYYY-MM-DD.',
    )
    .setVersion('1')
    .addCookieAuth('qarabic_session')
    .build();
  const doc = SwaggerModule.createDocument(app, config);
  for (const r of auditRoutes(app)) {
    const [method, route] = r.route.split(' ') as [string, string];
    const op = doc.paths[openApiPath(route)]?.[method.toLowerCase() as 'get'];
    if (!op) continue;
    const ext = op as unknown as Record<string, unknown>;
    ext['x-access'] = r.access;
    if (r.permissions.length) {
      ext['x-permissions'] = r.permissions;
      ext['x-permission-mode'] = r.mode;
    }
    if (r.access === 'public') op.security = [];
    else op.security = [{ cookie: [] }];
    op.responses ??= {};
    if (r.access !== 'public') op.responses['401'] ??= { description: 'No session.' };
    if (r.access === 'permission') {
      op.responses['403'] ??= {
        description: `Needs ${r.permissions.join(r.mode === 'any' ? ' or ' : ' and ')}.`,
      };
    }
  }
  return doc;
}
