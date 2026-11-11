import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants.js';
import { ModulesContainer, Reflector } from '@nestjs/core';
import type { INestApplicationContext } from '@nestjs/common';
import { AUTHENTICATED_KEY, PERMISSIONS_KEY, PUBLIC_KEY } from '../auth/decorators.js';

export interface RouteAccess {
  route: string;
  access: 'public' | 'authenticated' | 'permission' | 'none';
  permissions: string[];
}

const join = (...parts: Array<string | string[] | undefined>) =>
  parts
    .map((p) => (Array.isArray(p) ? p[0] : p) ?? '')
    .map((p) => p.replace(/^\/+|\/+$/g, ''))
    .filter(Boolean)
    .join('/');

/** Every HTTP route the app registers, with how it is protected. Used by the coverage test. */
export function auditRoutes(app: INestApplicationContext): RouteAccess[] {
  const reflector = new Reflector();
  const out: RouteAccess[] = [];
  for (const module of app.get(ModulesContainer).values()) {
    for (const wrapper of module.controllers.values()) {
      const cls = wrapper.metatype as (new (...args: never[]) => object) | null;
      if (!cls) continue;
      const base = Reflect.getMetadata(PATH_METADATA, cls) as string | string[] | undefined;
      const proto = cls.prototype as Record<string, unknown>;
      for (const name of Object.getOwnPropertyNames(proto)) {
        const handler = proto[name];
        if (name === 'constructor' || typeof handler !== 'function') continue;
        const path = Reflect.getMetadata(PATH_METADATA, handler) as string | string[] | undefined;
        if (path === undefined) continue;
        const method = Reflect.getMetadata(METHOD_METADATA, handler) as RequestMethod;
        const targets = [handler, cls];
        const perms = reflector.getAllAndOverride<string[] | undefined>(PERMISSIONS_KEY, targets);
        const access = reflector.getAllAndOverride<boolean>(PUBLIC_KEY, targets)
          ? 'public'
          : perms?.length
            ? 'permission'
            : reflector.getAllAndOverride<boolean>(AUTHENTICATED_KEY, targets)
              ? 'authenticated'
              : 'none';
        out.push({
          route: `${RequestMethod[method]} ${join(base, path)}`,
          access,
          permissions: perms ?? [],
        });
      }
    }
  }
  return out.sort((a, b) => a.route.localeCompare(b.route));
}
