import { beforeAll, describe, expect, it } from 'vitest';
import { fakeAuth, makeEnv } from '../../../../test/helpers/index.ts';
import { createFixtureIdentity } from '../../../passkit/testing/fixture-identity.ts';
import { createApp } from '../../app.ts';
import { all, first } from '../../platform/db.ts';
import type { AppEnv } from '../../platform/env.ts';
import { makeP8 } from './push-key-fixtures.ts';

const KEK_V1 = btoa(String.fromCharCode(...new Uint8Array(32).fill(9)));
const fake = fakeAuth();
const json = { 'content-type': 'application/json' };
let env: AppEnv;
let app: ReturnType<typeof createApp>;

const request = (path: string, init: RequestInit = {}) =>
  app.request(path, { ...init, headers: { ...fake.admin(), ...json } }, env);

async function create(label: string, passType: string, team: string): Promise<string> {
  const f = await createFixtureIdentity({ passTypeIdentifier: passType, teamIdentifier: team });
  env.SIGNER_PLATFORM_INTERMEDIATE = f.intermediate;
  const res = await request('/api/v1/identities', {
    method: 'POST',
    body: JSON.stringify({ label, certificatePem: f.certificate, privateKeyPem: f.privateKey }),
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { id: string }).id;
}
const putKey = async (id: string) =>
  request(`/api/v1/identities/${id}/push-key`, {
    method: 'PUT',
    body: JSON.stringify({ keyId: 'AB12CD34EF', p8: (await makeP8()).pem }),
  });
const keyRows = () => first<{ n: number }>(env.DB, 'SELECT count(*) AS n FROM apns_keys');

beforeAll(async () => {
  env = await makeEnv({ KEK_V1 });
  app = createApp({ stores: fake.stores });
});

describe('deleting an identity and the team push key', () => {
  it('keeps the key while another identity of the team remains, removes it with the last', async () => {
    const one = await create('One', 'pass.com.life.one', 'TEAMLIFE01');
    const two = await create('Two', 'pass.com.life.two', 'TEAMLIFE01');
    expect((await putKey(one)).status).toBe(200);

    expect((await request(`/api/v1/identities/${one}`, { method: 'DELETE' })).status).toBe(200);
    expect((await keyRows())?.n).toBe(1);
    expect(
      await first(env.DB, "SELECT 1 FROM audit_log WHERE action = 'identity.push_key_remove'"),
    ).toBeNull();

    expect((await request(`/api/v1/identities/${two}`, { method: 'DELETE' })).status).toBe(200);
    expect((await keyRows())?.n).toBe(0);
    const audit = await all<{ target_id: string; detail: string }>(
      env.DB,
      "SELECT target_id, detail FROM audit_log WHERE action = 'identity.push_key_remove'",
    );
    expect(audit).toHaveLength(1);
    expect(audit[0]?.target_id).toBe(two);
    expect(audit[0]?.detail).toContain('TEAMLIFE01');
  });

  it('a later identity of the same team starts without a key', async () => {
    const id = await create('Later', 'pass.com.life.later', 'TEAMLIFE02');
    expect((await putKey(id)).status).toBe(200);
    await request(`/api/v1/identities/${id}`, { method: 'DELETE' });
    const again = await create('Again', 'pass.com.life.again', 'TEAMLIFE02');
    const dto = (await (await request(`/api/v1/identities/${again}`)).json()) as {
      pushMethod: string;
      pushKey: unknown;
    };
    expect(dto).toMatchObject({ pushMethod: 'none', pushKey: null });
  });
});

describe('identity list', () => {
  it('shows each identity its own team key in one page', async () => {
    const a = await create('LA', 'pass.com.list.a', 'TEAMLIST01');
    await create('LB', 'pass.com.list.b', 'TEAMLIST02');
    await putKey(a);
    const page = (await (await request('/api/v1/identities?limit=50')).json()) as {
      items: { label: string; pushMethod: string; pushKey: { identityCount: number } | null }[];
    };
    expect(page.items.find((i) => i.label === 'LA')).toMatchObject({
      pushMethod: 'key',
      pushKey: { identityCount: 1 },
    });
    expect(page.items.find((i) => i.label === 'LB')).toMatchObject({
      pushMethod: 'none',
      pushKey: null,
    });
  });
});
