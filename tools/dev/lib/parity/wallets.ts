// Google and Samsung payloads for one issued pass, from the real compilers (CW3, CW4) and the
// fidelity report (CW5). No preview renderer exists yet (CW8), so the sheet shows these as tables.

import { planPass } from '../../../../src/passkit/build.ts';
import { bakedBehaviors, loadBaked } from '../../../../src/passkit/template/baked-fixtures.ts';
import { FIXTURE_IDENTITY } from '../../../../src/passkit/testing/fixture-identity.ts';
import type {
  Personalization,
  SigningMaterial,
  TemplateManifest,
} from '../../../../src/passkit/types.ts';
import { fidelityReport } from '../../../../src/passkit/wallets/fidelity.ts';
import { googleCompiler } from '../../../../src/passkit/wallets/google/compilers.ts';
import { samsungCompiler } from '../../../../src/passkit/wallets/samsung/index.ts';
import type {
  CompileResult,
  FidelityReport,
  WalletCompiler,
  WalletPassView,
} from '../../../../src/passkit/wallets/types.ts';
import { resolveWalletView } from '../../../../src/passkit/wallets/view.ts';
import { DEFAULT_TIME_ZONE } from '../../../../src/shared/time-zone.ts';

const NOW = new Date();
const assetUrl = (name: string) =>
  `https://parity.example/w/i/${name.replace(/[^A-Za-z0-9]+/gu, '-')}`;

export type WalletOut = {
  type: string;
  compiled: CompileResult;
  report: FidelityReport;
  /** The provider body as JSON text, for matching field values. */
  text: string;
};
export type WalletsOut = { google: WalletOut; samsung: WalletOut; view: WalletPassView };

/** The wallet view of the issued pass: the baked template's plan, with the real pass.json. */
export async function viewOfPass(
  slug: string,
  passJson: Record<string, unknown>,
  sample: Personalization,
): Promise<WalletPassView> {
  const { template, registry } = await loadBaked(slug);
  const plan = planPass({
    template,
    registry,
    input: sample,
    server: {
      serial: String(passJson.serialNumber ?? 'SERIAL'),
      authToken: 'a'.repeat(32),
      webServiceURL: 'https://wallet.example/wallet',
      organizationName: String(passJson.organizationName ?? 'PassBook'),
      identity: FIXTURE_IDENTITY,
      scanCode: 'PARITY-SCAN-CODE',
    },
    signing: {} as SigningMaterial,
    behaviors: bakedBehaviors,
    now: NOW,
  });
  return resolveWalletView(
    { ...plan, passJson: passJson as typeof plan.passJson },
    template.manifest as TemplateManifest,
    {
      now: NOW,
      timeZone: DEFAULT_TIME_ZONE,
      locales: ['en'],
      input: sample,
      assets: template.assets,
      // Providers fetch art from /w/i/<sha>; a stand-in host keeps images in the payload.
      assetUrl,
      // Samsung needs an app link: the org logo and name, the portal when it has no website (Q22).
      appLink: {
        name: String(passJson.organizationName ?? 'PassBook'),
        url: 'https://passbook.mobile',
        logo: assetUrl('logo@3x.png'),
      },
    },
  );
}

function run(compiler: WalletCompiler, view: WalletPassView): WalletOut {
  const compiled = compiler.compile(view, {
    now: NOW,
    omit: [],
    portalUrl: 'https://passbook.mobile',
  } as Parameters<WalletCompiler['compile']>[1]);
  const report = fidelityReport({ target: compiler.target, compiler, views: [view], now: NOW });
  const body = compiled.cardData ?? { class: compiled.classBody, object: compiled.objectBody };
  return { type: compiled.type, compiled, report, text: JSON.stringify(body) };
}

export async function compileWallets(
  slug: string,
  passJson: Record<string, unknown>,
  sample: Personalization,
): Promise<WalletsOut> {
  const view = await viewOfPass(slug, passJson, sample);
  return { google: run(googleCompiler, view), samsung: run(samsungCompiler, view), view };
}
