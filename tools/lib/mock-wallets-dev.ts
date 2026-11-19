import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import type { Plugin } from 'vite';

const port = Number(process.env.MOCK_WALLETS_PORT ?? 5175);
export const DEV_MOCK_WALLETS_URL = `http://localhost:${port}`;

/** `WALLET_MOCKS=1 npm run dev` starts test/mock-wallets beside Vite and stops it with the server. */
export function mockWallets(): Plugin {
  return {
    name: 'mock-wallets',
    apply: 'serve',
    configureServer(server) {
      if (process.env.WALLET_MOCKS !== '1') return;
      const child = spawn(
        'node',
        [resolve(import.meta.dirname, '../../test/mock-wallets/server.ts'), String(port)],
        {
          stdio: 'inherit',
        },
      );
      server.httpServer?.once('close', () => child.kill());
      process.once('exit', () => child.kill());
    },
  };
}
