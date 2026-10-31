import type { MyPass } from './pass-view.ts';

export function passFixture(over: Partial<MyPass> = {}): MyPass {
  return {
    id: 'p1',
    title: 'Gym membership',
    subtitle: null,
    templateName: 'Membership',
    orgName: 'Henrys',
    status: 'active',
    modifiedAt: 1_700_000_000_000,
    lastRefreshedAt: null,
    refreshRequestedAt: null,
    downloadUrl: '/p/abcdefghijklmnopqrst/pass.pkpass',
    passJson: {
      organizationName: 'Henrys',
      description: 'Membership',
      generic: { primaryFields: [{ key: 'name', label: 'Member', value: 'Sam Smith' }] },
    },
    assetBaseUrl: '/p/abcdefghijklmnopqrst/assets',
    assetNames: ['icon.png'],
    ...over,
  };
}
