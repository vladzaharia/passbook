import { type ApiKeyFixture, type Fixtures, makeApiKey } from '../../../../test/helpers/index.ts';
import type { Mode } from '../../../shared/contracts/common.ts';

/** Create the key with its immutable authority already set; an org-less key gets a live admin creator. */
export function makeTenantTestApiKey(
  f: Fixtures,
  options: {
    orgId?: string | null;
    scopes?: string[];
    name?: string;
    mode?: Mode;
    expiresAt?: number | null;
  } = {},
): Promise<ApiKeyFixture> {
  const { expiresAt, ...rest } = options;
  return makeApiKey(f, {
    ...rest,
    ...(expiresAt == null ? {} : { expiresAt }),
    scopes: options.scopes ?? ['passes:read', 'passes:write'],
  });
}
