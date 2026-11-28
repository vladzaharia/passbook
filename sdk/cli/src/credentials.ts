/** What `passbook login` keeps per origin. The token is a pbcli_test_ bearer: sent to `origin` only, never printed. */
export interface Profile {
  origin: string;
  token: string;
  tokenId: string;
  orgId: string;
  context: { kind: 'sandbox' | 'org'; name: string };
  account: { id: string; name: string; email: string };
  expiresAt: number;
}

export interface CredentialStore {
  get(origin: string): Promise<Profile | null>;
  set(profile: Profile): Promise<void>;
  delete(origin: string): Promise<void>;
}

export const DEFAULT_ORIGIN = 'https://passbook.mobile';

/** The origin a base URL names: `https://host:port`, no path. A base that is no URL is an error. */
export function originOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).origin;
  } catch {
    throw new Error(`PASSBOOK_BASE_URL is not a URL: ${baseUrl}`);
  }
}

const isProfile = (value: unknown): value is Profile => {
  const p = value as Partial<Profile> | null;
  return (
    typeof p?.origin === 'string' &&
    typeof p.token === 'string' &&
    typeof p.tokenId === 'string' &&
    typeof p.orgId === 'string' &&
    typeof p.expiresAt === 'number' &&
    typeof p.account?.id === 'string' &&
    typeof p.context?.name === 'string'
  );
};

/** A profile only counts for the origin it was issued by: a record under another origin is never returned. */
export const parseProfile = (text: string | null, origin: string): Profile | null => {
  if (!text) return null;
  try {
    const value: unknown = JSON.parse(text);
    return isProfile(value) && value.origin === origin ? value : null;
  } catch {
    return null;
  }
};

/** Used by tests and by the real stores: memory only. */
export function memoryStore(
  initial: Profile[] = [],
): CredentialStore & { all: Map<string, Profile> } {
  const all = new Map(initial.map((p) => [p.origin, p]));
  return {
    all,
    get: async (origin) => all.get(origin) ?? null,
    set: async (profile) => void all.set(profile.origin, profile),
    delete: async (origin) => void all.delete(origin),
  };
}
