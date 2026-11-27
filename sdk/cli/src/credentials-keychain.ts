import { type CredentialStore, type Profile, parseProfile } from './credentials.ts';

const SERVICE = 'passbook-cli';

/** Runs a program with no shell. `stdin` is the secret for `secret-tool` and `security -i`. */
export type Exec = (
  file: string,
  args: string[],
  stdin?: string,
) => Promise<{ code: number; stdout: string }>;

/** base64url, so the stored text is plain letters, digits, `-` and `_` and needs no quoting anywhere. */
const encode = (profile: Profile) => Buffer.from(JSON.stringify(profile)).toString('base64url');
const decode = (text: string) => Buffer.from(text.trim(), 'base64url').toString('utf8');

/**
 * The OS keychain through its own command: macOS `security` (the secret goes in on stdin through `security -i`, never
 * in the argument list) and libsecret's `secret-tool`. Null on any other system: the caller uses the 0600 file.
 */
export function keychainStore(platform: string, exec: Exec): CredentialStore | null {
  if (platform === 'darwin') {
    return {
      get: async (origin) => {
        const r = await exec('security', [
          'find-generic-password',
          '-s',
          SERVICE,
          '-a',
          origin,
          '-w',
        ]);
        return r.code === 0 ? parseProfile(decode(r.stdout), origin) : null;
      },
      set: async (p) => {
        const line = `add-generic-password -U -s ${SERVICE} -a "${p.origin}" -w ${encode(p)}\n`;
        const r = await exec('security', ['-i'], line);
        if (r.code !== 0) throw new Error('The keychain refused the sign-in.');
      },
      delete: async (origin) => {
        await exec('security', ['delete-generic-password', '-s', SERVICE, '-a', origin]);
      },
    };
  }
  if (platform === 'linux') {
    const attrs = (origin: string) => ['service', SERVICE, 'account', origin];
    return {
      get: async (origin) => {
        const r = await exec('secret-tool', ['lookup', ...attrs(origin)]);
        return r.code === 0 ? parseProfile(decode(r.stdout), origin) : null;
      },
      set: async (p) => {
        const r = await exec(
          'secret-tool',
          ['store', '--label=PassBook CLI', ...attrs(p.origin)],
          encode(p),
        );
        if (r.code !== 0) throw new Error('The keyring refused the sign-in.');
      },
      delete: async (origin) => {
        await exec('secret-tool', ['clear', ...attrs(origin)]);
      },
    };
  }
  return null;
}
