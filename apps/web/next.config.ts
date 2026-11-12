import type { NextConfig } from 'next';
import createNextIntlPlugin from 'next-intl/plugin';

const withNextIntl = createNextIntlPlugin('./i18n/request.ts');

const nextConfig: NextConfig = {
  // E2E builds (mocks on) go to their own folder so they never overwrite the real build.
  distDir: process.env.NEXT_DIST_DIR ?? '.next',
  // Served under a path (e.g. `/app` on api.qarabic.com, N8); set at build time. See lib/base-path.ts.
  ...(process.env.NEXT_PUBLIC_BASE_PATH ? { basePath: process.env.NEXT_PUBLIC_BASE_PATH } : {}),
  transpilePackages: ['@qarabic/ui'],
  poweredByHeader: false,
  // Do not write AGENTS.md into the app on `next dev`.
  agentRules: false,
};

export default withNextIntl(nextConfig);
