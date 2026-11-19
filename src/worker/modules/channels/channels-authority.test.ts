import { describe, expect, it } from 'vitest';
import { grant } from '../../platform/authority.ts';
import { db } from '../../platform/authority-ext-fixtures.ts';
import { setupGrant } from '../../platform/authority-test-fixtures.ts';
import { first } from '../../platform/db.ts';

describe('holder grants never write pass_channels (M1)', () => {
  it('a pass-pinned grant refuses pass_channels and still reaches pass_channel_copies', async () => {
    const x = await setupGrant('channels-holder');
    const row = await first<{
      identity_id: string;
      serial: string;
      auth_token: string;
      credential_generation: number;
    }>(
      db,
      'SELECT identity_id, serial, auth_token, credential_generation FROM passes WHERE id = ?',
      [x.s.pass.id],
    );
    const g = grant(x.route, {
      purpose: 'org_mode.pass.personalize',
      principal: {
        kind: 'holder',
        passId: x.s.pass.id,
        proof: {
          via: 'device',
          identityId: row?.identity_id ?? '',
          serial: row?.serial ?? '',
          authToken: row?.auth_token ?? '',
          credentialGeneration: row?.credential_generation ?? 0,
        },
      },
    });
    expect(() =>
      g.upsert(
        'pass_channels',
        ['pass_id', 'template_id', 'channel', 'override', 'set_by', 'set_at'],
        [x.s.pass.id, 't', 'apple', 'off', 'u', 1],
        { update: ['override'] },
      ),
    ).toThrow();
    expect(() =>
      g.upsert(
        'pass_channel_copies',
        ['pass_id', 'channel', 'copy_at'],
        [x.s.pass.id, 'apple', 1],
        { doNothing: true },
      ),
    ).not.toThrow();
  });
});
