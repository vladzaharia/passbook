import { describe, expect, it } from 'vitest';

/** Source text by path under src/worker, test and fixture files left out. */
const SOURCES = Object.fromEntries(
  Object.entries(
    import.meta.glob<string>('../../**/*.{ts,tsx}', {
      query: '?raw',
      import: 'default',
      eager: true,
    }),
  )
    .filter(([path]) => !/\.test\.|test-|fixtures/.test(path))
    .map(([path, text]) => [
      new URL(path, 'file:///src/worker/modules/channels/').pathname.replace('/src/worker/', ''),
      text,
    ]),
);
const ARTIFACT =
  /servePassFile\(|serveCurrentPassFile\(|currentPassBytes\(|\/pass\.pkpass|passes\.pkpasses|BUCKET\.get\([^)]*(?:objectKey|object_key)|packagePassObjects\(|packagePasses\(|listWalletOffers\(|issueWalletOffer\(/i;
const GATE =
  /channelGate\(|appleFileGate\(|channelOn\(|holderChannels\(|holderChannelsMany\(|appleVariant\(|eligibleWalletProvider\(|channels\.effective\.(?:apple|mobile)\.on/;

/** Every file that hands a .pkpass or a wallet offer to a holder goes through the one gate (M11). */
const GATED = [
  'modules/apple/routes.ts',
  'modules/public/routes.ts',
  'modules/me/bundle.ts',
  'modules/bundles/public-routes.ts',
  'modules/bundles/public-service.ts',
  'modules/bundles/public-items.ts',
  'modules/bundles/public-member.ts',
  'modules/bundles/deliver.ts',
  'modules/delivery/email.ts',
  'modules/sandbox/service.ts',
  'modules/wallet-providers/offers.ts',
  'modules/me/service.ts',
];

/** Files that name an artifact but do not deliver one to a holder. */
const EXEMPT: Record<string, string> = {
  'platform/security-headers.ts': 'CSP names the download path',
  'ssr/bundle-page.tsx': 'renders links the route handler decides',
  'email/bundle.ts': 'renders links the delivery decides',
  'modules/me/routes.ts': 'the .pkpasses route; its body is me/bundle.ts',
  'modules/apple/variant.ts': 'builds the voided copy; apple/routes.ts decides when',
  'modules/passes/file.ts': 'the shared file server; callers gate',
  'modules/passes/timed-variant.ts': 'the timed render of the file server; callers gate',
  'modules/passes/package-objects.ts': 'the shared archive writer; callers gate',
  'modules/passes/detail.ts': 'admin links (passes:operate)',
  'modules/passes/import-results.ts': 'admin import report (passes:operate)',
  'modules/passes/import-check-run.ts': 'admin import (passes:operate)',
  'modules/passes/import-read.ts': 'admin import (passes:operate)',
  'modules/orgs/email-preview.ts': 'sample email for admins',
  'modules/templates/import-pipeline.ts': 'template import, not a holder surface',
  'modules/wallet-providers/routes-offers.ts': 'routes call issueWalletOffer, gated in offers.ts',
  'modules/bundles/wallet-links.ts':
    'calls listWalletOffers and issueWalletOffer, gated in offers.ts',
};

describe('channel gate coverage', () => {
  it('every holder artifact surface is gated or explicitly exempt', () => {
    const found = Object.keys(SOURCES)
      .filter((f) => ARTIFACT.test(SOURCES[f] ?? ''))
      .sort();
    expect(found).toEqual([...GATED, ...Object.keys(EXEMPT)].sort());
  });

  it.each(GATED)('%s uses the gate', (file) => {
    expect(SOURCES[file]).toMatch(GATE);
  });

  it('appleFileGate, the file routes gate, still runs the channel gate for apple', () => {
    expect(SOURCES['modules/channels/gate.ts']).toMatch(
      /function appleFileGate[\s\S]*?await channelGate\(ctx, pass, 'apple'\)/,
    );
  });
});

/** In the route files, each handler that serves an artifact names its own gate (or a gated helper). */
const ROUTE_GATE = /channelGate\(|appleFileGate\(|appleVariant\(|bundleArchive\(/;
describe('channel gate per route', () => {
  it.each([
    'modules/apple/routes.ts',
    'modules/public/routes.ts',
    'modules/bundles/public-routes.ts',
  ])('%s', (file) => {
    const handlers = (SOURCES[file] ?? '').split(/\bregister\(/).slice(1);
    const serving = handlers.filter((h) => ARTIFACT.test(h) && !/path: '\/\{token\}'/.test(h));
    expect(serving.length).toBeGreaterThan(0);
    for (const h of serving) expect(h).toMatch(ROUTE_GATE);
  });
});
