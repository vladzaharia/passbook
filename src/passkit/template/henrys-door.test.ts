import { beforeAll, describe, expect, it } from 'vitest';
import { buildPass } from '../build.ts';
import { createFixtureIdentity, FIXTURE_IDENTITY } from '../testing/fixture-identity.ts';
import type { SigningMaterial } from '../types.ts';
import { bakedBehaviors, freezeNow, loadBaked } from './baked-fixtures.ts';
import { scanManifestIssues } from './scan.ts';

let material: SigningMaterial;
let now: Date;
beforeAll(async () => {
  material = await createFixtureIdentity();
  now = freezeNow();
});

describe.each(['henrys-blue', 'henrys-copper'])('%s at the door', (slug) => {
  it('has a valid scan block: daily check-in, member-number lookup, stopping status flag', async () => {
    const { template } = await loadBaked(slug, { strips: false });
    const scan = template.manifest.scan;
    expect(scan?.actions).toEqual([
      { id: 'check_in', label: 'Check in', kind: 'check_in', repeat: 'daily', minRole: 'door' },
    ]);
    expect(scan?.lookup).toEqual({ input: 'memberId' });
    expect(scan?.flags).toEqual([
      {
        input: 'status',
        label: 'Membership',
        equals: ['Suspended', 'Expired', 'Cancelled'],
        stop: true,
      },
    ]);
    const errors = scanManifestIssues(template.manifest, { passJson: template.passJson }).filter(
      (i) => i.severity === 'error',
    );
    expect(errors).toEqual([]);
  });

  it('leaves the pass the holder sees byte-identical to the one built without scan', async () => {
    const { template, registry } = await loadBaked(slug);
    const { scan: _scan, ...withoutScan } = template.manifest;
    const build = (manifest: typeof template.manifest) =>
      buildPass({
        template: { ...template, manifest },
        registry,
        input: template.manifest.sample,
        server: {
          serial: 'SNAPSHOT-SERIAL',
          authToken: 'a'.repeat(32),
          webServiceURL: 'https://wallet.example/wallet',
          organizationName: template.manifest.org?.name ?? 'PassBook',
          identity: FIXTURE_IDENTITY,
        },
        signing: material,
        behaviors: bakedBehaviors,
        now,
      });
    const before = await build(withoutScan);
    const after = await build(template.manifest);
    expect(after.contentHash).toBe(before.contentHash);
    expect(after.passJson).toEqual(before.passJson);
    const faces = (files: Record<string, Uint8Array>) =>
      Object.entries(files)
        .filter(([name]) => name !== 'signature')
        .map(([name, bytes]) => [name, Buffer.from(bytes).toString('base64')]);
    expect(faces(after.signed.files)).toEqual(faces(before.signed.files));
    expect(after.signed.manifest).toEqual(before.signed.manifest);
  });
});
