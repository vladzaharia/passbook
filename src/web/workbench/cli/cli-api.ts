import { z } from 'zod';
import { CliSessionReviewSchema } from '@/shared/contracts/cli.ts';
import { sessionJson } from '../host/session-fetch.ts';

const Ok = z.object({ ok: z.literal(true) });

export type CliReview = z.infer<typeof CliSessionReviewSchema>;

/** The three calls of the approve page: cookie session and CSRF, no token and no mode header. */
export const cliApi = {
  lookup: (userCode: string, csrf: string | undefined): Promise<CliReview> =>
    sessionJson('/api/v1/cli/sessions/lookup', CliSessionReviewSchema, {
      method: 'POST',
      body: { userCode },
      ...(csrf ? { csrf } : {}),
    }),
  approve: async (id: string, orgId: string, csrf: string | undefined): Promise<void> => {
    await sessionJson(`/api/v1/cli/sessions/${encodeURIComponent(id)}/approve`, Ok, {
      method: 'POST',
      body: { orgId },
      ...(csrf ? { csrf } : {}),
    });
  },
  deny: async (id: string, csrf: string | undefined): Promise<void> => {
    await sessionJson(`/api/v1/cli/sessions/${encodeURIComponent(id)}/deny`, Ok, {
      method: 'POST',
      body: {},
      ...(csrf ? { csrf } : {}),
    });
  },
};

/** Where "Not you?" goes: Polaris ID asks for the account again, and returns here. */
export const SWITCH_ACCOUNT_HREF = `/auth/oidc/start?prompt=login&next=${encodeURIComponent('/workbench/cli')}`;

/** The typed code survives the step-up's round trip through Polaris ID (this tab only), then is dropped. */
const KEPT = 'wb-cli-code';
export const keepCode = (code: string): void => {
  try {
    sessionStorage.setItem(KEPT, code);
  } catch {
    // Storage is blocked: the person types it again.
  }
};
export const takeKeptCode = (): string => {
  try {
    const code = sessionStorage.getItem(KEPT) ?? '';
    sessionStorage.removeItem(KEPT);
    return code;
  } catch {
    return '';
  }
};
