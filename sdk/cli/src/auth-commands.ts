import { parseArgs } from 'node:util';
import { type CredentialStore, DEFAULT_ORIGIN, originOf } from './credentials.ts';
import { type LoginIo, login, logout } from './login.ts';
import { openCommand } from './open.ts';

/** What the sign-in commands add to the command line's `Io`: where tokens live, a browser, a clock. */
export interface AuthIo {
  env: Record<string, string | undefined>;
  out: (line: string) => void;
  credentials?: CredentialStore | undefined;
  openBrowser?: ((url: string) => Promise<void>) | undefined;
  sleep?: ((ms: number, signal?: AbortSignal) => Promise<void>) | undefined;
  now?: (() => number) | undefined;
  os?: string | undefined;
  fetch?: typeof fetch | undefined;
  signal?: AbortSignal | undefined;
}

/** The origin the command line talks to: `PASSBOOK_BASE_URL`, else https://passbook.mobile. */
export const originFor = (env: Record<string, string | undefined>): string =>
  originOf(env.PASSBOOK_BASE_URL?.trim() || DEFAULT_ORIGIN);

const wait = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });

export function loginIo(io: AuthIo, version: string, browser: boolean): LoginIo {
  if (!io.credentials) throw new Error('This system has no place to keep a sign-in.');
  return {
    origin: originFor(io.env),
    version,
    os: io.os ?? 'unknown',
    store: io.credentials,
    fetch: io.fetch ?? fetch,
    out: io.out,
    openBrowser: browser ? io.openBrowser : undefined,
    sleep: io.sleep ?? wait,
    now: io.now ?? Date.now,
    signal: io.signal,
  };
}

/** `login`, `logout` and `open`: none needs `PASSBOOK_KEY`. */
export async function authCommand(
  command: 'login' | 'logout' | 'open',
  args: string[],
  io: AuthIo,
  version: string,
): Promise<void> {
  if (command === 'login') {
    const { values } = parseArgs({
      args,
      options: { switch: { type: 'boolean' }, 'no-browser': { type: 'boolean' } },
    });
    return login(loginIo(io, version, values['no-browser'] !== true), {
      switchAccount: values.switch === true,
    });
  }
  const { positionals } = parseArgs({ args, allowPositionals: true });
  if (command === 'logout') return logout(loginIo(io, version, false));
  return openCommand(loginIo(io, version, true), positionals[0]);
}
