import { beforeEach, describe, expect, it } from 'vitest';
import { makeScanStaff } from '../../../../test/helpers/index.ts';
import { UnavailableError } from '../../platform/errors.ts';
import { createServiceContext } from '../../platform/service-context.ts';
import { getStaff } from './repo-staff.ts';
import { createStaff, resetStaffPin } from './staff-admin.ts';
import { setupStaffAdminTestKit } from './staff-admin-test-fixtures.ts';

const kit = setupStaffAdminTestKit();
let env: typeof kit.env;
let f: typeof kit.f;
let clock: typeof kit.clock;
let orgId: typeof kit.orgId;
beforeEach(() => {
  ({ env, f, clock, orgId } = kit);
});

/** A context whose PIN draws come from `draws`, then `fallback`. */
function ctxDrawing(draws: string[], fallback = '777777') {
  const ctx = createServiceContext(env, { clock });
  let used = 0;
  ctx.ids.code = () => draws[used++] ?? fallback;
  return ctx;
}

describe('PINs are unique among active staff', () => {
  it('create skips a PIN an active member has, and one a disabled member has is fine', async () => {
    await makeScanStaff(f, { orgId, pin: '505050' });
    await makeScanStaff(f, { orgId, pin: '606060', disabled: true });
    const ctx = ctxDrawing(['505050', '606060']);
    const { auth, authority } = await kit.serviceAuthority(ctx);
    const made = await createStaff(ctx, auth, authority, 'live', {
      orgId,
      name: 'Unique A',
      role: 'door',
    });
    expect(made.pin).toBe('606060');
  });

  it('reset skips a PIN an active member has, and never repeats the old one', async () => {
    const other = await makeScanStaff(f, { orgId, pin: '707070' });
    const person = await makeScanStaff(f, { orgId, pin: '808080' });
    const ctx = ctxDrawing(['707070', '808080', '909090']);
    const { auth, authority } = await kit.serviceAuthority(ctx);
    const observed = await getStaff(env.DB, orgId, person.id);
    if (!observed) throw new Error('Staff fixture missing');
    const reset = await resetStaffPin(ctx, auth, authority, observed);
    expect(reset.pin).toBe('909090');
    expect(other.pin).not.toBe(reset.pin);
  });

  it('gives up with a retryable error when every draw is taken', async () => {
    await makeScanStaff(f, { orgId, pin: '404040' });
    const ctx = ctxDrawing([], '404040');
    const { auth, authority } = await kit.serviceAuthority(ctx);
    await expect(
      createStaff(ctx, auth, authority, 'live', { orgId, name: 'Unique B', role: 'door' }),
    ).rejects.toBeInstanceOf(UnavailableError);
  });
});
