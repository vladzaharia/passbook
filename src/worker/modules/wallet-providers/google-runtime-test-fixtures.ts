// Shared by the Google runtime tests: a schema 2 Google release on the mock wallet server, no real Google.
import { expect, vi } from 'vitest';
import { installKeysetTestEnv } from '../../../../test/helpers/credential-keyset.ts';
import { createMockWallets } from '../../../../test/mock-wallets/index.ts';
import type { CompileResult } from '../../../passkit/wallets/types.ts';
import { run } from '../../platform/db.ts';
import { getVersion } from '../templates/repo.ts';
import { listWalletOffers } from './offers.ts';
import { setupWalletOfferKit } from './offers-test-fixtures.ts';
import { computeProjectionPins } from './projection-pins.ts';
import {
  approveProjectionCandidate,
  createProjectionCandidate,
  publishProjectionRelease,
} from './projection-service.ts';
import { updateCompiler } from './projection-v2-test-fixtures.ts';
import { setWalletProvidersEnabledForTest } from './provider-policy.ts';
import { releaseRows } from './release-test-fixtures.ts';

export const testEnv = installKeysetTestEnv();
export const mock = createMockWallets();
/** Undo functions the fixtures registered; the test file runs them after each test. */
export const restore: (() => void)[] = [];

export const text = (value: string) => ({ defaultValue: { language: 'en', value } });
export const logo = {
  sourceUri: { uri: 'https://example.test/w/i/logo.png' },
  contentDescription: text('Logo'),
};
export const barcode = { type: 'QR_CODE', renderEncoding: 'UTF_8', value: 'PSAMPLE' } as const;

/** Google, as the mock: provider hosts map onto it, nothing else leaves the test. */
export function routeFetchToMock(): void {
  mock.reset();
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const target =
      url.hostname === 'oauth2.googleapis.com'
        ? 'http://mock.test/token'
        : url.pathname.startsWith('/gp/v/save/')
          ? `http://mock.test${url.pathname}`
          : url.hostname === 'walletobjects.googleapis.com'
            ? `http://mock.test${url.pathname}`
            : null;
    if (!target) throw new Error(`Unexpected request to ${url.hostname}`);
    const { redirect: _r, signal: _s, ...rest } = init ?? {};
    return mock.handle(new Request(target, rest));
  });
}

/** Reviews and publishes the schema 2 Google release of the fixture's template at the given head generation. */
export async function publishRelease(
  f: Awaited<ReturnType<typeof setupWalletOfferKit>>,
  generation: number,
) {
  const { kit, apple } = f;
  const version = await getVersion(kit.env.DB, kit.template.id, kit.template.version);
  if (!version) throw new Error('Offer fixture version is missing.');
  const { pins } = await computeProjectionPins(kit.ctx, 'google', version);
  const scope = { orgId: kit.org.id, mode: 'live' as const, provider: 'google' as const };
  const candidate = await createProjectionCandidate(kit.ctx, apple.authorAuth, kit.template.id, {
    ...scope,
    version: kit.template.version,
    sourceReleaseId: apple.id,
    projection: { schema: 2, provider: 'google', approvedOmissions: pins.approvedOmissions },
  });
  const approval = await approveProjectionCandidate(
    kit.ctx,
    apple.reviewerAuth,
    kit.template.id,
    candidate.id,
    { ...scope, candidateHash: candidate.candidateHash },
  );
  await publishProjectionRelease(kit.ctx, apple.publisherAuth, kit.template.id, {
    ...scope,
    candidateId: candidate.id,
    approvalId: approval.id,
    candidateHash: candidate.candidateHash,
    expectedGeneration: generation,
  });
  return pins;
}

/** A pass with a published schema 2 Google release; `compile` stands in for a template of another type. */
export async function fixture(
  compile?: Parameters<typeof updateCompiler>[0],
  options: { enrolled?: boolean; guards?: boolean } = {},
) {
  if (compile) restore.push(updateCompiler(compile, 0));
  routeFetchToMock();
  const f = await setupWalletOfferKit({
    google: 'configured',
    samsung: 'absent',
    db: (await testEnv()).DB,
    ...(options.enrolled ? { enrolled: true } : {}),
  });
  const pins = await publishRelease(f, 0);
  restore.push(setWalletProvidersEnabledForTest(true));
  if (options.guards) {
    // Every database guard stays: Google Live is released in the table too, so each one runs as in production.
    await releaseRows(f.kit.env.DB);
    return { f, pins };
  }
  // The database refuses a new provider instance and every offer (0043, 0114) until issuance is lifted
  // per account (Q2). This file's own database opens the four triggers that say so, and nothing else.
  for (const name of [
    'wallet_provider_generation_insert_guard',
    'wallet_provider_generation_binding_guard',
    'wallet_provider_generation_offer_insert',
    'wallet_provider_generation_offer_consume',
  ])
    await run(f.kit.env.DB, `DROP TRIGGER IF EXISTS ${name}`);
  return { f, pins };
}

export const loyalty = (result: CompileResult): CompileResult => ({
  ...result,
  type: 'loyalty',
  classBody: {
    multipleDevicesAndHoldersAllowedStatus: 'ONE_USER_ALL_DEVICES',
    issuerName: 'Club',
    reviewStatus: 'UNDER_REVIEW',
    programName: 'Club',
    programLogo: logo,
  },
  objectBody: { state: 'ACTIVE', accountId: 'M1', barcode },
});

/** The capability token of the pass, as a holder's link carries it. */
export async function tokenOf(f: Awaited<ReturnType<typeof fixture>>['f']): Promise<string> {
  const [offer] = await listWalletOffers(f.kit.ctx, f.pass.id);
  const token = offer?.href.split('/')[2];
  if (!token) throw new Error('The released Google design offered no link.');
  return token;
}

export const savedObjectIds = async (location: string) => {
  const opened = await fetch(location);
  expect(opened.status).toBe(200);
  return mock.saves.at(-1)?.objectIds;
};
