import { persistTemplate } from '../../../../test/helpers/index.ts';
import { createApp } from '../../app.ts';
import { run } from '../../platform/db.ts';
import { jobCtxOf } from '../delivery/delivery-test-fixtures.ts';
import { approveAppleRelease } from '../passes/apple-release-test-fixtures.ts';
import { createPassRow } from '../passes/create.ts';
import type { setupSamsungCallbacks } from '../wallet-providers/callbacks-test-fixtures.ts';

type Samsung = Awaited<ReturnType<typeof setupSamsungCallbacks>>;

const PERSONALIZATION_BODY = {
  personalizationToken: 'wallet-personalization-token',
  requiredPersonalizationInfo: { fullName: 'Old Holder', emailAddress: 'old@example.test' },
};

/** A pass whose template asks for personalization, personalized through Wallet's own POST. */
export async function personalizeThroughRoute(t: Samsung): Promise<{ id: string; text: string }> {
  const { kit } = t;
  const icon = new Uint8Array(
    await new Response(await kit.registry.openAsset(kit.template, 'icon.png')).arrayBuffer(),
  );
  const template = kit.registry.add({
    id: `personalizable-${kit.ctx.ids.token(8)}`,
    orgId: kit.template.orgId,
    version: kit.template.version,
    manifest: kit.template.manifest,
    passJson: kit.template.passJson,
    assets: {
      'icon.png': icon,
      'personalizationLogo.png': icon,
      'personalization.json': new TextEncoder().encode(
        JSON.stringify({
          description: 'Join',
          requiredPersonalizationFields: [
            'PKPassPersonalizationFieldName',
            'PKPassPersonalizationFieldEmailAddress',
          ],
        }),
      ),
    },
  });
  await persistTemplate(kit.fx, template, { registry: kit.registry });
  const apple = await approveAppleRelease(kit, {
    templateId: template.id,
    version: template.version,
  });
  // The build refuses personalization.json unless the signing identity is NFC-entitled.
  await run(kit.env.DB, 'UPDATE signing_identities SET nfc_enabled = 1 WHERE 1 = 1');
  const pass = await createPassRow(jobCtxOf(kit), {
    orgId: kit.org.id,
    templateId: template.id,
    templateVersion: apple.version,
    releaseId: apple.id,
    releaseGeneration: apple.generation,
    input: { memberName: 'Alex Morgan' },
    holderEmail: null,
    source: 'manual',
    mode: 'live',
    execution: { kind: 'system' },
    actor: { type: 'system', id: null },
  });
  const response = await createApp({ clock: kit.clock }).request(
    `https://wallet.test/wallet/v1/passes/pass.im.plrs.wallet/${pass.serial}/personalize`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(PERSONALIZATION_BODY),
    },
    kit.env,
  );
  if (response.status !== 200) throw new Error(`personalize answered ${response.status}`);
  return { id: pass.id, text: JSON.stringify(PERSONALIZATION_BODY.requiredPersonalizationInfo) };
}
