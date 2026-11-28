import type { CredentialStore, Profile } from './credentials.ts';

/** The slice of the environment `login`, `logout` and `open` use. `bin.ts` supplies the real one. */
export interface LoginIo {
  origin: string;
  version: string;
  os: string;
  store: CredentialStore;
  fetch: typeof fetch;
  out: (line: string) => void;
  openBrowser?: ((url: string) => Promise<void>) | undefined;
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  now: () => number;
  signal?: AbortSignal | undefined;
}

interface Problem {
  code?: string;
  detail?: string;
}

const post = (io: LoginIo, path: string, body: unknown, headers: Record<string, string> = {}) =>
  io.fetch(`${io.origin}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json', ...headers },
    body: JSON.stringify(body),
    redirect: 'error',
    ...(io.signal ? { signal: io.signal } : {}),
  });

const problem = async (res: Response): Promise<Problem> =>
  ((await res.json().catch(() => ({}))) as Problem) ?? {};

/** The text a person reads for a polling answer that ends the sign-in. */
const ENDINGS: Record<string, string> = {
  CLI_CODE_DENIED: 'The sign-in was denied.',
  CLI_CODE_EXPIRED: 'The code expired. Run passbook login again.',
  CLI_ACCOUNT_MISMATCH:
    'Approved by a different account. Run `passbook login --switch` to change accounts.',
};

/**
 * `passbook login` (RFC 8628's device flow, with no code in the URL): prints the code and the page, opens the page
 * without the code, and polls until the person approves it there. `switchAccount` leaves out the stored account.
 */
export async function login(io: LoginIo, options: { switchAccount: boolean }): Promise<void> {
  const profile = await io.store.get(io.origin);
  const started = await post(io, '/api/v1/cli/sessions', {
    client: { name: 'passbook-cli', version: io.version, os: io.os },
    ...(profile && !options.switchAccount ? { accountHint: profile.account.id } : {}),
  });
  if (!started.ok)
    throw new Error((await problem(started)).detail ?? `Sign-in failed (${started.status}).`);
  const s = (await started.json()) as {
    deviceCode: string;
    userCode: string;
    verificationUri: string;
    expiresIn: number;
    interval: number;
  };
  const page = new URL(s.verificationUri);
  if (page.origin !== io.origin)
    throw new Error(`The server named another origin: ${page.origin}.`);
  io.out(`Open ${page.origin}${page.pathname} and enter the code: ${s.userCode}`);
  io.out('Check the code matches before you approve.');
  // The page, never the code: the person types it.
  await io.openBrowser?.(`${page.origin}${page.pathname}`)?.catch(() => undefined);
  const until = io.now() + s.expiresIn * 1000;
  let interval = s.interval * 1000;
  while (io.now() < until) {
    await io.sleep(interval, io.signal);
    if (io.signal?.aborted) throw new Error('Cancelled.');
    const res = await post(io, '/api/v1/cli/sessions/token', { deviceCode: s.deviceCode });
    if (res.ok) {
      const t = (await res.json()) as Omit<Profile, 'origin'> & { origin: string };
      // A token is kept for the origin that issued it, and only if that is the one asked.
      if (t.origin !== io.origin)
        throw new Error(`Refusing a token for another origin: ${t.origin}.`);
      await io.store.set({
        origin: io.origin,
        token: t.token,
        tokenId: t.tokenId,
        orgId: t.orgId,
        context: t.context,
        account: t.account,
        expiresAt: t.expiresAt,
      });
      if (io.os === 'Windows')
        io.out(
          'Windows keeps the token in your profile folder, not Credential Manager. Keep that folder private.',
        );
      io.out(`Signed in as ${t.account.email} to ${t.context.name} (Test).`);
      return;
    }
    const { code, detail } = await problem(res);
    if (code === 'CLI_AUTH_PENDING') continue;
    if (code === 'CLI_SLOW_DOWN') interval += 5000;
    else if (res.status === 429) interval += 5000;
    else throw new Error((code && ENDINGS[code]) ?? detail ?? `Sign-in failed (${res.status}).`);
  }
  throw new Error(ENDINGS.CLI_CODE_EXPIRED);
}

/** `passbook logout`: the server ends the token (best effort), then the profile goes. */
export async function logout(io: LoginIo): Promise<void> {
  const profile = await io.store.get(io.origin);
  if (!profile) {
    io.out('Not signed in.');
    return;
  }
  let ended = false;
  try {
    const res = await io.fetch(
      `${io.origin}/api/v1/cli/tokens/${encodeURIComponent(profile.tokenId)}`,
      {
        method: 'DELETE',
        headers: { authorization: `Bearer ${profile.token}`, accept: 'application/json' },
        redirect: 'error',
      },
    );
    // 401: it was already ended or expired, which is what logout wants.
    ended = res.ok || res.status === 401;
  } catch {
    ended = false;
  }
  await io.store.delete(io.origin);
  io.out(
    ended
      ? 'Signed out.'
      : 'Signed out here. The server could not be reached, so end the token in Keys.',
  );
}
