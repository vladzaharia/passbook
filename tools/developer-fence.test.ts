import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The owner's invariant (PX7): a developer org never issues a real wallet pass: no signed .pkpass, no Google or
 * Samsung object, no add-to-wallet link, no APNs push, no real mail. This test finds, in the code, every place
 * that signs, mints, pushes or sends, and fails when one has no fence, so a new entry point cannot land without
 * one. It reads the source; `src/worker/modules/developer/never-issue.test.ts` runs the fences.
 */
const root = join(import.meta.dirname, '..');

const PRIMITIVES: Record<string, RegExp> = {
  'sign a pass': /\b(?:signPass|signManifest|buildPass|packagePassBytes|packagePasses?)\(/,
  'read a stored .pkpass': /\b(?:BUCKET|bucket)\.get\([^)]*\b(?:objectKey|object_key)\b/,
  'mint a Google object or link':
    /\b(?:createGoogleSaveOffer|signGoogleJwt|(?:upsert|patch)GoogleGeneric(?:Class|Object)|inactivateGoogleGenericObject|createGoogleRuntimeOffer|(?:upsert|patch|inactivate)GoogleRuntime(?:Class|Object))\(/,
  'mint a Samsung card or link':
    /\b(?:createSamsung(?:AuthorizationToken|CardDataToken)|buildSamsungDataFetchLink|sendSamsung(?:Update|Cancel)|createSamsungRuntimeOffer|sendSamsungRuntimeUpdate)\(/,
  'push to APNs':
    /\b(?:apns\.send|createApnsTransport|createKeyApnsTransport|createMtlsApnsTransport)\(/,
  'send mail': /\b(?:mailer\.send|EMAIL\.send|createEmailBindingMailer)\(/,
};

/** What makes a file fenced: a call that asks whether the org is a developer org, or checks the stored object. */
const FENCE = /\b(?:assertNotPreviewOnly|isPreviewOnlyOrg|assertSignedObject|notPreviewOnlySql)\b/;

interface Exempt {
  reason: string;
  /** The fenced file this one runs under: it must itself carry a fence. */
  via?: string;
}

const LIBRARY = 'a library with no org: its callers are listed here and fenced';
const IMPORT_FILE = 'reads an uploaded import file (a CSV or a template package), never a pass';
const CREDENTIALS =
  'reads a provider credential only through runtime-core-credentials.ts, whose gate refuses a developer org';

/** Every file that holds a primitive and no fence of its own, with why that is safe. */
const EXEMPT: Record<string, Exempt> = {
  'src/worker/modules/passes/import-read.ts': { reason: IMPORT_FILE },
  'src/worker/modules/passes/import-check-run.ts': { reason: IMPORT_FILE },
  'src/worker/modules/templates/import-pipeline.ts': { reason: IMPORT_FILE },
  'src/worker/modules/wallet-providers/sync-operation-google.ts': {
    reason: CREDENTIALS,
    via: 'src/worker/modules/wallet-providers/runtime-core-credentials.ts',
  },
  'src/worker/modules/wallet-providers/offers-google.ts': {
    reason: CREDENTIALS,
    via: 'src/worker/modules/wallet-providers/runtime-core-credentials.ts',
  },
  'src/worker/modules/wallet-providers/sync-operation-samsung.ts': {
    reason: CREDENTIALS,
    via: 'src/worker/modules/wallet-providers/runtime-core-credentials.ts',
  },
  'src/passkit/build.ts': { reason: LIBRARY },
  'src/passkit/sign/index.ts': { reason: LIBRARY },
  'src/passkit/package/zip.ts': { reason: LIBRARY },
  'src/worker/modules/identities/alerts.ts': {
    reason:
      'mails platform admins about the platform identities, never an org or a holder: a developer org has no such mail to send',
  },
  'src/worker/modules/scan/pin-digest.ts': {
    reason:
      'mails an org its own admins about scanner PIN events: a developer org holds no scanner, terminal or staff PIN, so no event exists to report',
  },
  'src/worker/modules/scan/pin-only-notice.ts': {
    reason:
      'mails an org its own admins after wrong PINs on a paired scanner: a developer org has no paired scanner to enter one',
  },
  'src/worker/modules/idp/invitations/platform-service.ts': {
    reason:
      'mails a platform invitation to a Polaris ID group, no org: only a platform admin issues one, and a developer org has no platform role to send it',
  },
  'src/worker/modules/identities/certificates.ts': {
    reason:
      'signs a probe manifest to prove an uploaded certificate matches its key: the signature is checked and dropped, never stored, served or sent',
  },
  'src/worker/modules/templates/build-check.ts': {
    reason:
      'a validation build of a template sample with the platform identity: the output is checked and dropped, never stored, served or sent',
  },
  'src/worker/modules/wallet-providers/google-offer.ts': {
    reason: CREDENTIALS,
    via: 'src/worker/modules/wallet-providers/runtime-core-credentials.ts',
  },
  'src/worker/modules/wallet-providers/google-crypto.ts': {
    reason: CREDENTIALS,
    via: 'src/worker/modules/wallet-providers/runtime-core-credentials.ts',
  },
  'src/worker/modules/wallet-providers/google-oauth.ts': {
    reason: CREDENTIALS,
    via: 'src/worker/modules/wallet-providers/runtime-core-credentials.ts',
  },
  'src/worker/modules/wallet-providers/google-rest.ts': {
    reason: CREDENTIALS,
    via: 'src/worker/modules/wallet-providers/runtime-core-credentials.ts',
  },
  'src/worker/modules/wallet-providers/runtime-google.ts': {
    reason: CREDENTIALS,
    via: 'src/worker/modules/wallet-providers/runtime-core-credentials.ts',
  },
  'src/worker/modules/wallet-providers/runtime-samsung.ts': {
    reason: CREDENTIALS,
    via: 'src/worker/modules/wallet-providers/runtime-core-credentials.ts',
  },
  'src/worker/modules/wallet-providers/samsung.ts': {
    reason: CREDENTIALS,
    via: 'src/worker/modules/wallet-providers/runtime-core-credentials.ts',
  },
  'src/worker/modules/wallet-providers/samsung-token.ts': {
    reason: CREDENTIALS,
    via: 'src/worker/modules/wallet-providers/runtime-core-credentials.ts',
  },
  'src/worker/modules/wallet-providers/samsung-template.ts': {
    reason:
      'checks a credential against Samsung with a probe: no card, link or push is made, and a developer org holds no credential (wallet.samsung is not in its plan)',
  },
  'src/worker/modules/wallet-providers/account-check-samsung.ts': {
    reason:
      'checks a credential against Samsung with a probe: no card, link or push is made, and a developer org holds no credential (wallet.samsung is not in its plan)',
  },
  'src/worker/modules/delivery/apns.ts': {
    reason: 'the transport itself: every send site is fenced',
  },
  'src/worker/modules/auth/account-claims.ts': {
    reason:
      "tells a person's own verified addresses that Polaris ID was linked to their account: no org or pass is involved",
  },
  'src/worker/modules/delivery/mailer.ts': {
    reason: 'the mailer itself: every send site is fenced',
  },
  'src/worker/modules/passes/deps.ts': {
    reason: 'builds the transport and the mailer for the sites above; it sends nothing',
  },
  'src/worker/modules/auth/magic-service.ts': {
    reason: 'a sign-in link to the person who asked for it: no org is involved',
  },
  'src/worker/modules/marketing/service.ts': {
    reason:
      "an access request from the public site to PassBook's own inbox: the recipient is fixed and no org or pass is involved",
  },
  'src/worker/modules/org-lifecycle/service.ts': {
    reason:
      "a closure notice to the org's own admins, from the platform: no pass and no third party",
  },
  'src/worker/modules/retention/notify.ts': {
    reason:
      "a retention notice to the org's own admins, from the platform: no pass and no third party",
  },
};

function* sourceFiles(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (name !== 'generated' && name !== 'node_modules') yield* sourceFiles(path);
    } else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$|fixtures?|test-kit|test-support/.test(name))
      yield path;
  }
}

/** Code only: no comments (whole-line or trailing), no import lines, no string contents of one line. */
const strip = (text: string) =>
  text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*import\b[\s\S]*?from\s+['"][^'"]+['"];?\s*$/gm, '')
    .replace(/\s\/\/.*$/gm, '');

interface Hit {
  file: string;
  kinds: string[];
  fenced: boolean;
}

function scan(): Hit[] {
  const hits: Hit[] = [];
  for (const path of sourceFiles(join(root, 'src'))) {
    const code = strip(readFileSync(path, 'utf8'));
    const kinds = Object.entries(PRIMITIVES)
      .filter(([, re]) => re.test(code))
      .map(([kind]) => kind);
    if (kinds.length > 0)
      hits.push({ file: relative(root, path), kinds, fenced: FENCE.test(code) });
  }
  return hits;
}

const hits = scan();
const text = (file: string) => strip(readFileSync(join(root, file), 'utf8'));

describe('the developer fence', () => {
  it('finds the entry points in the code', () => {
    // A guard against a pattern that stopped matching: these places exist today.
    const files = hits.map((h) => h.file);
    for (const known of [
      'src/worker/modules/passes/builder.ts',
      'src/worker/modules/delivery/push.ts',
      'src/worker/modules/delivery/email.ts',
      'src/worker/modules/wallet-providers/runtime-google.ts',
      'src/worker/modules/wallet-providers/samsung-token.ts',
      'src/worker/modules/passes/file.ts',
    ])
      expect(files, known).toContain(known);
    expect(new Set(hits.flatMap((h) => h.kinds)).size).toBe(Object.keys(PRIMITIVES).length);
  });

  it('fences every place that signs, mints, pushes or sends, or says why it is safe', () => {
    const unfenced = hits
      .filter((h) => !h.fenced && !EXEMPT[h.file])
      .map((h) => `${h.file} (${h.kinds.join(', ')})`);
    expect(
      unfenced,
      'Each of these signs, mints, pushes or sends. Ask assertNotPreviewOnly(db, orgId) (modules/developer/fence.ts) before it, or add it to EXEMPT with the reason a developer org cannot reach it.',
    ).toEqual([]);
  });

  it('keeps no exemption that is stale or lies about its fence', () => {
    const byFile = new Map(hits.map((h) => [h.file, h]));
    const stale = Object.keys(EXEMPT).filter((file) => !byFile.has(file));
    expect(stale, 'These no longer hold a primitive: remove them from EXEMPT.').toEqual([]);
    const fencedAnyway = Object.keys(EXEMPT).filter((file) => byFile.get(file)?.fenced);
    expect(fencedAnyway, 'These carry a fence now: remove them from EXEMPT.').toEqual([]);
    for (const [file, { via }] of Object.entries(EXEMPT))
      if (via) expect(FENCE.test(text(via)), `${file} runs under ${via}`).toBe(true);
  });

  it('holds the credential gate where every provider call passes', () => {
    const gate = text('src/worker/modules/wallet-providers/runtime-core-credentials.ts');
    expect(gate).toMatch(
      /assertWalletProviderEnabled\(provider, scope\.mode\);\s*await assertNotPreviewOnly/,
    );
  });
});
