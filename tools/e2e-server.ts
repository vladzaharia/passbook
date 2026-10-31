// Playwright webServer: mock Pocket ID + local D1 + vite dev on 5173.
import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const children: ChildProcess[] = [];

const env = {
  ...process.env,
  CLOUDFLARE_INCLUDE_PROCESS_ENV: 'true',
  OIDC_ISSUER: 'http://localhost:5174',
  OIDC_CLIENT_ID: 'wallet-e2e',
  OIDC_CLIENT_SECRET: 'e2e-secret',
  TURNSTILE_SECRET: '1x0000000000000000000000000000000AA',
};

execFileSync('node', ['tools/dev-vars.ts'], { cwd: root, stdio: 'inherit' });
execFileSync('npx', ['wrangler', 'd1', 'migrations', 'apply', 'wallet-platform', '--local'], {
  cwd: root,
  stdio: 'inherit',
});

children.push(
  spawn('node', ['test/mock-oidc/server.ts', '5174'], { cwd: root, stdio: 'inherit', env }),
);
children.push(
  spawn('npx', ['vite', 'dev', '--port', '5173', '--strictPort'], {
    cwd: root,
    stdio: 'inherit',
    env,
  }),
);

const stop = () => {
  for (const child of children) child.kill();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
