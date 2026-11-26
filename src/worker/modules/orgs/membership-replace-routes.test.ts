import { beforeAll, describe, expect, it } from 'vitest';
import { expectProblem } from '../../../../test/helpers/denial.ts';
import { fakeAuth, fixtures, makeEnv, makeOrg, makeUser } from '../../../../test/helpers/index.ts';
import {
  OrgInvitationSchema,
  OrgMemberSchema,
  type OrgRole,
} from '../../../shared/contracts/org-membership.ts';
import { createApp } from '../../app.ts';
import { ManualClock } from '../../platform/clock.ts';
import { run } from '../../platform/db.ts';
import type { AppEnv } from '../../platform/env.ts';

const fake = fakeAuth();
const clock = new ManualClock();
const mail: { to: string }[] = [];
let env: AppEnv;
const app = createApp({ stores: fake.stores, clock });
const call = (method: string, path: string, body?: unknown, headers = fake.admin()) =>
  app.request(
    `/api/v1/orgs${path}`,
    {
      method,
      headers: {
        ...headers,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
    env,
  );

beforeAll(async () => {
  env = await makeEnv({
    PUBLIC_BASE_URL: 'https://wallet.test',
    EMAIL_FROM: 'passes@example.test',
    EMAIL: {
      send: async (message: { to: string }) => {
        mail.push(message);
        return { messageId: 'm' };
      },
    } as unknown as AppEnv['EMAIL'],
  });
  fake.bindSessions(env.DB, clock);
  await run(
    env.DB,
    "INSERT OR IGNORE INTO users (id, primary_email, created_at) VALUES ('admin-1', 'replace-routes-admin@example.test', ?)",
    [clock.now()],
  );
});

async function member(orgId: string, roles: OrgRole[]) {
  const f = fixtures(env, clock);
  const person = await makeUser(f);
  const invite = await call('POST', `/${orgId}/invitations`, { email: person.primaryEmail, roles });
  expect(invite.status).toBe(201);
  const text = mail.at(-1) as unknown as { text: string };
  const token = new URL(
    text.text.match(/https:\/\/wallet\.test\/invite#[^\s<>"']+/)?.[0] ?? '',
  ).hash.slice(1);
  const accepted = await call('POST', '/invitations/accept', { token }, fake.user(person.id));
  expect(accepted.status).toBe(200);
  return { person, membershipId: ((await accepted.json()) as { id: string }).id };
}

describe('PATCH /orgs/{id}/memberships/{membershipId}', () => {
  it('answers with the member and their new roles', async () => {
    const org = await makeOrg(fixtures(env, clock));
    const { membershipId, person } = await member(org.id, ['read_only']);
    const res = await call('PATCH', `/${org.id}/memberships/${membershipId}`, {
      roles: ['pass_operator', 'template_author'],
    });
    expect(res.status).toBe(200);
    const body = OrgMemberSchema.parse(await res.json());
    expect(body.userId).toBe(person.id);
    expect(body.roles).toEqual(['pass_operator', 'template_author']);
  });

  it('refuses Organization admin beside another role with a validation error', async () => {
    const org = await makeOrg(fixtures(env, clock));
    const { membershipId } = await member(org.id, ['read_only']);
    const res = await call('PATCH', `/${org.id}/memberships/${membershipId}`, {
      roles: ['org_admin', 'pass_operator'],
    });
    expect(res.status).toBe(422);
  });

  it('refuses a member who is not an org admin', async () => {
    const org = await makeOrg(fixtures(env, clock));
    const target = await member(org.id, ['read_only']);
    const operator = await member(org.id, ['pass_operator']);
    const res = await call(
      'PATCH',
      `/${org.id}/memberships/${target.membershipId}`,
      { roles: ['template_author'] },
      fake.user(operator.person.id),
    );
    expect(res.status).toBe(403);
  });
});

describe('POST /orgs/{id}/invitations/{invitationId}/resend', () => {
  it('answers 201 with the new invitation and mails it', async () => {
    const org = await makeOrg(fixtures(env, clock));
    const made = await call('POST', `/${org.id}/invitations`, {
      email: 'resend-route@example.test',
      roles: ['read_only'],
    });
    const old = OrgInvitationSchema.parse(await made.json());
    const count = mail.length;
    const res = await call('POST', `/${org.id}/invitations/${old.id}/resend`);
    expect(res.status).toBe(201);
    const fresh = OrgInvitationSchema.parse(await res.json());
    expect(fresh.id).not.toBe(old.id);
    expect(mail).toHaveLength(count + 1);
    await expectProblem(
      await call('POST', `/${org.id}/invitations/${old.id}/resend`),
      409,
      'MEMBERSHIP_CONFLICT',
    );
  });

  it('is for a console session: an API key without a session is refused', async () => {
    const org = await makeOrg(fixtures(env, clock));
    const res = await call(
      'POST',
      `/${org.id}/invitations/x/resend`,
      undefined,
      fake.apiKey({ orgId: org.id, scopes: ['members:write'] }),
    );
    expect([401, 403]).toContain(res.status);
  });
});
