// A membership delivery actor acts from a request context only at the reviewed issuance resume.
import { beforeAll, describe, expect, it } from 'vitest';
import { makeEnv } from '../../../../test/helpers/index.ts';
import type { AppEnv } from '../../platform/env.ts';
import { createJobContext, createServiceContext } from '../../platform/service-context.ts';
import { type DeliveryActor, deliveryGrant } from './delivery-actor.ts';

let env: AppEnv;
beforeAll(async () => {
  env = await makeEnv();
});

const member: DeliveryActor = {
  kind: 'membership',
  membershipId: 'membership-1',
  orgRevision: 1,
  userRevision: 1,
  mode: 'live',
};
const input = { action: 'email_send', orgId: 'org-1', mode: 'live' as const, checks: [] };

describe('deliveryGrant and the request context', () => {
  it('refuses a membership actor in a request context by default', () => {
    expect(() => deliveryGrant(createServiceContext(env), member, input)).toThrow(
      'A deferred principal is built in a queue, cron or workflow context.',
    );
  });

  it('allows it at the reviewed site, and always in a job context', () => {
    expect(() =>
      deliveryGrant(createServiceContext(env), member, { ...input, allowRequestContext: true }),
    ).not.toThrow();
    expect(() => deliveryGrant(createJobContext(env, 'test'), member, input)).not.toThrow();
  });
});
