import { PasswordsService } from '../src/auth/passwords.service.js';
import { loadEnv } from '../src/config/env.js';
import { createPrismaClient } from '../src/prisma/prisma.service.js';
import { syncRolesAndPermissions } from '../src/rbac/sync-roles.js';
import { seedDemoCrm } from './seed-crm.js';
import { seedCourses, seedDemoPeople } from './seed-people.js';
import { seedDemoSchedule } from './seed-schedule.js';
import { seedDemoSupport } from './seed-support.js';
import { seedDemoTeaching } from './seed-teaching.js';

/**
 * `pnpm --filter @qarabic/api db:seed` — idempotent.
 * Roles, permissions and the reference courses always; the dev admin (from env vars) and the
 * made-up demo people (see seed-people.ts; `SEED_DEMO=0` skips them) only outside production.
 */
async function main(): Promise<void> {
  const env = loadEnv();
  const prisma = createPrismaClient(env.DATABASE_URL);
  try {
    await syncRolesAndPermissions(prisma);
    console.log('Roles and permissions synced.');
    await seedCourses(prisma);
    console.log('Courses seeded.');

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

    if (env.NODE_ENV !== 'production' && process.env.SEED_DEMO !== '0') {
      const added = await seedDemoPeople(prisma);
      console.log(added ? 'Demo people added (fake data).' : 'Demo people already there.');
      const scheduled = await seedDemoSchedule(prisma, env.APP_ENCRYPTION_KEY);
      console.log(
        scheduled
          ? 'Demo enrollments, weekly times and two weeks of classes added (fake data).'
          : 'Demo schedule already there (or no demo people).',
      );
      const taught = await seedDemoTeaching(prisma);
      console.log(
        taught
          ? 'Demo lesson reports, hifz progress and three tests added (fake data).'
          : 'Demo lesson reports already there (or no demo classes).',
      );
      const tickets = await seedDemoSupport(prisma);
      console.log(
        tickets
          ? 'Demo «تواصل معنا» tickets added (fake data).'
          : 'Demo tickets already there (or no demo people).',
      );
      const leads = await seedDemoCrm(prisma);
      console.log(leads ? 'Demo leads added (fake data).' : 'Leads already there.');
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
