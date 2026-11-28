import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { type CredentialStore, type Profile, parseProfile } from './credentials.ts';

/** `$XDG_CONFIG_HOME` or `~/.config`, then `passbook/credentials.json`. Never the working directory. */
export function credentialsPath(env: Record<string, string | undefined>, home = homedir()): string {
  const base = env.XDG_CONFIG_HOME?.trim() || join(home, '.config');
  return join(base, 'passbook', 'credentials.json');
}

async function readAll(path: string): Promise<Record<string, unknown>> {
  try {
    const value: unknown = JSON.parse(await readFile(path, 'utf8'));
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/** One profile per origin in a JSON file: mode 0600 in a 0700 folder, written whole and renamed into place. */
export function fileStore(path: string): CredentialStore {
  const write = async (all: Record<string, unknown>) => {
    const dir = dirname(path);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await chmod(dir, 0o700);
    const temp = `${path}.${process.pid}.tmp`;
    await writeFile(temp, `${JSON.stringify(all, null, 2)}\n`, { mode: 0o600 });
    await rename(temp, path);
    await chmod(path, 0o600);
  };
  return {
    get: async (origin) =>
      parseProfile(JSON.stringify((await readAll(path))[origin] ?? null), origin),
    set: async (profile: Profile) => write({ ...(await readAll(path)), [profile.origin]: profile }),
    delete: async (origin) => {
      const { [origin]: _gone, ...rest } = await readAll(path);
      if (Object.keys(rest).length === 0) await rm(path, { force: true });
      else await write(rest);
    },
  };
}
