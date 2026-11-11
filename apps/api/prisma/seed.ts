import { PasswordsService } from '../src/auth/passwords.service.js';
import { loadEnv } from '../src/config/env.js';
import { createPrismaClient } from '../src/prisma/prisma.service.js';
import { syncRolesAndPermissions } from '../src/rbac/sync-roles.js';

/**
 * `pnpm --filter @qarabic/api db:seed` — idempotent.
 * Roles + permissions always; the dev admin only outside production and only from env vars.
 */
async function main(): Promise<void> {
  const env = loadEnv();
  const prisma = createPrismaClient(env.DATABASE_URL);
  try {
    await syncRolesAndPermissions(prisma);
    console.log('Roles and permissions synced.');

    const email = process.env.SEED_ADMIN_EMAIL?.trim().toLowerCase();
    const password = process.env.SEED_ADMIN_PASSWORD;
    if (env.NODE_ENV === 'production') {
      console.log('Production: no seed users.');
    } else if (email && password) {
      const admin = await prisma.role.findUniqueOrThrow({ where: { name: 'admin' } });
      const exists = await prisma.user.findUnique({ where: { email } });
      if (exists) {
        console.log('Dev admin already exists (left unchanged).');
      } else {
        await prisma.user.create({
          data: {
            name: 'Dev admin',
            email,
            passwordHash: await new PasswordsService().hash(password),
            roleId: admin.id,
          },
        });
        console.log('Dev admin created from SEED_ADMIN_EMAIL.');
      }
    } else {
      console.log('SEED_ADMIN_EMAIL / SEED_ADMIN_PASSWORD not set: no dev admin.');
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
