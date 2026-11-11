import { approveAppleRelease } from '../passes/apple-release-test-fixtures.ts';
import { setupSamsungCallbacks } from '../wallet-providers/callbacks-test-fixtures.ts';
import { setupScanKit } from './test-kit.ts';

/** A provider account is created once per org and mode, so each fixture gets its own kit. */
export async function providerFixture() {
  const own = await setupScanKit();
  const ownTemplateId = await own.scanTemplate('Provider transfer', {
    actions: [{ id: 'check_in', label: 'Check in', kind: 'check_in' }],
    lookup: { input: 'memberNo' },
  });
  const template = await own.registry.resolve(ownTemplateId);
  const apple = await approveAppleRelease(own, {
    templateId: ownTemplateId,
    version: template.version,
  });
  const pass = await own.scanPass(
    ownTemplateId,
    { memberName: 'Transfer Source Member' },
    { holderEmail: 'transfer-old@example.test' },
  );
  return setupSamsungCallbacks({
    promoted: false,
    source: { kit: { ...own, template }, apple, pass, barcode: 'qr' },
  });
}
