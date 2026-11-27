import type { Mode } from '../../shared/contracts/common.ts';

export type ApiKeyKind = 'service' | 'personal' | 'platform';

/**
 * The text a secret starts with. The label says what a leaked token is (and lets a secret scanner
 * match it); the stored hash covers the whole string, so a label cannot be swapped. `wlt_` is the
 * original format: still valid, no longer issued.
 */
const LABEL: Record<ApiKeyKind, string> = { service: 'pb', personal: 'pbp', platform: 'pbo' };

const TOKEN = /^(wlt|pb|pbp|pbo|pbcli)_(?:(live|test)_)?([A-Za-z0-9_-]{8})_([A-Za-z0-9_-]{43})$/;

/** Any bearer that is shaped like an API key (not a scanner token or a session). */
export const API_KEY_LABEL = /^(?:wlt|pb|pbp|pbo|pbcli)_/;

/** What a new key's secret starts with: `<pb|pbp|pbo>_<live|test>`; a CLI sign-in's token is `pbcli_test`. */
export const secretLabel = (kind: ApiKeyKind, mode: Mode, origin: 'app' | 'cli' = 'app') =>
  origin === 'cli' ? `pbcli_${mode}` : `${LABEL[kind]}_${mode}`;

/** The text a CLI token (`pbcli_test_…`) starts with. */
export const CLI_TOKEN_PREFIX = 'pbcli_';

/** The lookup prefix of a presented key, or null when it is not shaped like one. */
export const apiKeyPrefixOf = (raw: string): string | null => TOKEN.exec(raw)?.[3] ?? null;
