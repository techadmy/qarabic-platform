import type { Request } from 'express';
import type { Locale, RoleKind } from '../generated/prisma/enums.js';

export interface AuthUser {
  id: number;
  name: string;
  email: string;
  locale: Locale;
  timezone: string;
  role: { id: number; name: string; kind: RoleKind } | null;
  permissions: ReadonlySet<string>;
}

export interface AuthedRequest extends Request {
  auth?: { user: AuthUser; sessionId: string };
}
