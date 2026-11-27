import { unzipSync } from 'fflate';
import { expect } from 'vitest';
import { createFakeApns } from '../../../../test/helpers/fakes.ts';
import { makeSession, makeUser } from '../../../../test/helpers/index.ts';
import {
  createFixtureIdentity,
  FIXTURE_IDENTITY,
} from '../../../passkit/testing/fixture-identity.ts';
import type { PassJson } from '../../../passkit/types.ts';
import { run } from '../../platform/db.ts';
import { logKit } from '../developer/request-log-test-fixtures.ts';
import { bearer, ORIGIN } from '../developer/try-token-test-fixtures.ts';
import { createDbIdentityResolver } from '../identities/db-resolver.ts';
import type { ResolvedIdentity } from '../identities/env-identity.ts';
import { PLATFORM_SLOTS } from '../identities/provision-platform.ts';
import { overrideDeps } from '../passes/deps.ts';

const DEVTEST_ID = 'identity-devtest';
const decoder = new TextDecoder();

/** The sandbox kit with the device-test identity (its own throwaway CA), device passes on, and a fake APNs. */
export async function devicePassKit() {
  const t = await logKit();
  const { env, clock, f } = t.kit;
  const passType = PLATFORM_SLOTS.devtest.passType;
  const fixture = await createFixtureIdentity(FIXTURE_IDENTITY, {
    now: new Date(clock.now() - 86_400_000),
    days: 3650,
    caDays: 3650,
    siblings: [{ passTypeIdentifier: passType, teamIdentifier: FIXTURE_IDENTITY.teamIdentifier }],
  });
  const sibling = fixture.siblings[0];
  if (!sibling) throw new Error('fixture sibling missing');
  const devtest: ResolvedIdentity = {
    id: DEVTEST_ID,
    orgId: null,
    label: 'PassBook device test',
    passTypeIdentifier: passType,
    teamIdentifier: FIXTURE_IDENTITY.teamIdentifier,
    nfcEnabled: false,
    apnsBinding: 'APNS',
    material: {
      certificate: sibling.certificate,
      privateKey: sibling.privateKey,
      intermediate: fixture.intermediate,
    },
  };
  const real = createDbIdentityResolver(env);
  const apns = createFakeApns();
  overrideDeps(env, {
    apns,
    identities: { ...real, byId: async (id) => (id === DEVTEST_ID ? devtest : real.byId(id)) },
  });
  env.DEVICE_PASS_ENABLED = '1';
  await run(
    env.DB,
    "INSERT INTO credentials (id, kind, kek_version, iv, wrapped_dek, ciphertext, created_at) VALUES ('cred-devtest', 'pass_signer', 1, x'00', x'00', x'00', 1)",
  );
  await run(
    env.DB,
    `INSERT INTO signing_identities
         (id, org_id, label, pass_type_identifier, team_identifier, source, credential_id, cert_pem, not_after,
          provenance, purpose, apns_health, is_default, issuing, created_at)
       VALUES (?, NULL, 'devtest', ?, ?, 'db', 'cred-devtest', ?, ?, 'platform', 'device_test', 'healthy', 0, 1, 1)`,
    [
      DEVTEST_ID,
      passType,
      FIXTURE_IDENTITY.teamIdentifier,
      sibling.certificate,
      clock.now() + 3650 * 86_400_000,
    ],
  );

  const api = (
    method: string,
    path: string,
    headers: Record<string, string>,
    body?: unknown,
    key: string | null = f.ids.token(),
  ) =>
    t.call(path, {
      method,
      headers: {
        ...headers,
        'content-type': 'application/json',
        ...(key ? { 'idempotency-key': key } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

  /** A request outside `/api/v1`: the public download and Wallet's web service. */
  const background: Promise<unknown>[] = [];
  const raw = (path: string, init: RequestInit = {}) =>
    t.app.request(`${ORIGIN}${path}`, init, env, {
      waitUntil: (p: Promise<unknown>) => void background.push(p),
      passThroughOnException() {},
    } as unknown as ExecutionContext);
  /** Waits for the background work of every call, `/api/v1` or not. */
  const settle = async () => {
    await t.settle();
    await Promise.all(background.splice(0));
  };

  /** A developer with a sandbox and one Test pass made from its sample. */
  async function developer() {
    const d = await t.developer();
    const headers = { ...bearer(d.key.secret) };
    const detail = (await (
      await t.call(`/templates/${d.made.templateId}`, { headers })
    ).json()) as { manifest: { sample?: Record<string, unknown> } };
    const make = async () => {
      const res = await api('POST', '/passes', headers, {
        templateId: d.made.templateId,
        input: detail.manifest.sample ?? {},
      });
      expect(res.status, await res.clone().text()).toBe(201);
      await settle();
      return ((await res.json()) as { id: string }).id;
    };
    return { ...d, headers, make, sample: detail.manifest.sample ?? {}, passId: await make() };
  }

  /** A signed-in person without a sandbox or developer access. */
  async function outsider(roles: ('admin' | 'user' | 'developer')[] = ['user']) {
    const user = await makeUser(f);
    const session = await makeSession(f, { userId: user.id, roles });
    return {
      user,
      headers: { ...session.headers, origin: ORIGIN, 'sec-fetch-site': 'same-origin' },
    };
  }

  /** The pass.json of a downloaded .pkpass. */
  const passJsonOf = (bytes: Uint8Array): PassJson & { authenticationToken: string } =>
    JSON.parse(decoder.decode(unzipSync(bytes)['pass.json'])) as never;

  /** Turns the flag on or off. */
  const flag = (on: boolean) => {
    env.DEVICE_PASS_ENABLED = on ? '1' : '0';
  };
  /** Stops the device-test identity issuing (or starts it again). */
  const identityIssuing = (on: boolean) =>
    run(env.DB, 'UPDATE signing_identities SET issuing = ? WHERE id = ?', [on ? 1 : 0, DEVTEST_ID]);

  return {
    ...t,
    settle,
    api,
    raw,
    developer,
    outsider,
    passJsonOf,
    flag,
    identityIssuing,
    apns,
    devtest,
    passType,
  };
}

export type DevicePassKit = Awaited<ReturnType<typeof devicePassKit>>;
