import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { ENV, type Env } from '../config/env.js';
import { PrismaClient } from '../generated/prisma/client.js';

/**
 * Every connection runs with `TimeZone=UTC`. The pg adapter sends timestamps as UTC text without an
 * offset, so on a database whose default zone is not UTC (e.g. Africa/Cairo) Postgres would read
 * them as local time and store them shifted — invisible to the app, wrong for SQL, reports and the
 * N8 import. Forcing the session zone makes storage independent of the server's setting.
 */
export function prismaAdapter(databaseUrl: string): PrismaPg {
  return new PrismaPg({ connectionString: databaseUrl, options: '-c TimeZone=UTC' });
}

export function createPrismaClient(databaseUrl: string): PrismaClient {
  return new PrismaClient({ adapter: prismaAdapter(databaseUrl) });
}

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleDestroy {
  constructor(@Inject(ENV) env: Env) {
    super({ adapter: prismaAdapter(env.DATABASE_URL) });
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
