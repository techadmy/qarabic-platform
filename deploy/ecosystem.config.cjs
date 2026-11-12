// pm2 processes of the new stack on the droplet (docs/36 §3.5, §5.3).
//
// Start them by name, never all at once:
//   pm2 start deploy/ecosystem.config.cjs --only qarabic-api,qarabic-web
//   pm2 start deploy/ecosystem.config.cjs --only qarabic-api-rehearsal,qarabic-web-rehearsal
//
// - Runs as the `qarabic` user (its own PM2_HOME); pm2 itself may run on the system Node 18,
//   every process runs on Node 24 from /opt/node24 (`interpreter`).
// - Secrets are read by Node from the env file (`--env-file`); none is in this file.
// - The API listens on PORT from its env file. It binds every interface (Nest has no HOST
//   setting yet): ufw allows only 22/80/443, so 4100/4200 stay private. Next binds 127.0.0.1.
// - `current` is a symlink to the active release (deploy/release.sh).
'use strict';

const SRV = process.env.QARABIC_SRV || '/srv/qarabic';
const ETC = process.env.QARABIC_ETC || '/etc/qarabic';
const LOGS = process.env.QARABIC_LOG_DIR || '/var/log/qarabic';
const NODE = `${process.env.QARABIC_NODE_DIR || '/opt/node24'}/bin/node`;

const common = {
  interpreter: NODE,
  exec_mode: 'fork',
  instances: 1,
  autorestart: true,
  max_restarts: 10,
  min_uptime: '10s',
  restart_delay: 2000,
  kill_timeout: 10000,
  time: true,
  merge_logs: true,
};

/** NestJS API. `rehearsal` = second process on the rehearsal database, scheduler off. */
function api(name, release, envFiles) {
  return {
    ...common,
    name,
    cwd: `${SRV}/${release}/apps/api`,
    script: 'dist/main.js',
    // Several files: the last one wins (the rehearsal file only overrides api.env).
    node_args: envFiles.map((f) => `--env-file=${f}`),
    // NODE_ENV comes from the env file; pm2's own env adds nothing secret.
    env: { TZ: 'UTC' },
    max_memory_restart: '768M',
    out_file: `${LOGS}/${name}.out.log`,
    error_file: `${LOGS}/${name}.err.log`,
  };
}

/** Next.js web app under basePath /app (baked at build time, deploy/release.sh). */
function web(name, release, port, distDir) {
  return {
    ...common,
    name,
    cwd: `${SRV}/${release}/apps/web`,
    script: 'node_modules/next/dist/bin/next',
    args: `start -p ${port} -H 127.0.0.1`,
    env: { NODE_ENV: 'production', TZ: 'UTC', NEXT_DIST_DIR: distDir },
    max_memory_restart: '768M',
    out_file: `${LOGS}/${name}.out.log`,
    error_file: `${LOGS}/${name}.err.log`,
  };
}

module.exports = {
  apps: [
    api('qarabic-api', 'current', [`${ETC}/api.env`]), // 127.0.0.1:4100 via PORT in api.env
    web('qarabic-web', 'current', 4000, '.next'),
    api('qarabic-api-rehearsal', 'current', [`${ETC}/api.env`, `${ETC}/api-rehearsal.env`]), // :4200
    web('qarabic-web-rehearsal', 'current', 4001, '.next-rehearsal'),
  ],
};
