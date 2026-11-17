import { expect, vi } from 'vitest';
import { countD1, makeUser } from '../../../../test/helpers/index.ts';
import { createApp } from '../../app.ts';
import { denyAllStores } from '../../platform/auth.ts';
import type { ManualClock } from '../../platform/clock.ts';
import { insertSession } from '../auth/repo-sessions.ts';
import { createSessionStore, hashSessionCookie } from '../auth/sessions.ts';
import { putMemberPhoto } from '../passes/member-photo.ts';
import { clearSettingsCache } from '../settings/service.ts';
import { makePng } from '../templates/package/fixtures.ts';
import { interceptBatches, kit, templateId } from './lookup-output-test-fixtures.ts';
import { setPhotoGroup } from './repo-lookup-output-test-fixtures.ts';
import { isFinalFenceBatch } from './repo-read-grant-expiry-test-fixtures.ts';
import { STAFF_IDLE_MS, STAFF_MAX_MS } from './staff-binding.ts';
import { grantScanMembership, ORIGIN } from './test-kit.ts';

export const GROUP = 'expiry-photo-group';
export const PRIVATE_EMAIL = 'expiry-private@example.test';
const png = btoa(String.fromCharCode(...makePng(270, 270)));

type Route = 'resolve' | 'lookup';
export type ActorExpiry =
  | 'session idle'
  | 'session absolute'
  | 'scanner absolute'
  | 'staff idle'
  | 'staff absolute';
export type Post = (route: Route, body: Record<string, unknown>) => Promise<Response>;

export async function photoPass(name: string) {
  const pass = await kit.scanPass(templateId, { memberName: name }, { holderEmail: PRIVATE_EMAIL });
  await setPhotoGroup(kit.env.DB, pass.id, GROUP);
  await putMemberPhoto(
    kit.ctx,
    { type: 'system', id: null },
    pass.id,
    { png, includeInPass: false },
    null,
  );
  return pass;
}

export async function principal(kind: ActorExpiry | 'valid') {
  const now = kit.clock.now();
  if (kind.startsWith('session')) {
    const user = await makeUser(kit.fx);
    await grantScanMembership(kit.fx, kit.org.id, user.id, ['read_only']);
    const cookie = kit.fx.ids.token();
    const csrf = kit.fx.ids.token();
    await insertSession(kit.env.DB, {
      idHash: await hashSessionCookie(cookie),
      userId: user.id,
      amr: 'oidc',
      roles: ['user'],
      csrfSecret: csrf,
      now,
      expiresAt: kind === 'session absolute' ? now + 1_000 : now + 60_000,
      idleExpiresAt: kind === 'session idle' ? now + 1_000 : now + 60_000,
      ipPrefix: null,
      userAgent: null,
    });
    const headers = {
      cookie: `__Host-wallet_sid=${cookie}`,
      'x-csrf-token': csrf,
      'sec-fetch-site': 'same-origin',
    };
    const app = createApp({
      stores: { ...denyAllStores, sessions: createSessionStore(kit.env, kit.clock) },
      clock: kit.clock,
    });
    const scope = { orgId: kit.org.id, templateIds: [templateId], timeZone: 'UTC' };
    const post: Post = (route, body) =>
      Promise.resolve(
        app.request(
          `${ORIGIN}/api/v1/scan/${route}`,
          {
            method: 'POST',
            headers: { ...headers, origin: ORIGIN, 'content-type': 'application/json' },
            body: JSON.stringify({ ...body, scope }),
          },
          kit.env,
        ),
      );
    return { post, advance: 2_000, headers: null, scannerId: null };
  }
  const staff = kind.startsWith('staff') ? await kit.staff('door') : null;
  const scanner = await kit.scanner({
    templateIds: [templateId],
    ...(kind === 'scanner absolute' ? { expiresAt: now + 1_000 } : {}),
    ...(staff
      ? {
          staffId: staff.id,
          staffSince: kind === 'staff absolute' ? now - STAFF_MAX_MS + 1_000 : now,
          staffSeenAt: now,
          settings: { staffSignIn: true },
        }
      : {}),
  });
  const post: Post = (route, body) => kit.post(scanner.headers, `/${route}`, body);
  return {
    post,
    advance: kind === 'staff idle' ? STAFF_IDLE_MS + 1 : 2_000,
    headers: scanner.headers,
    scannerId: scanner.id,
  };
}

function jsonArray(data: BufferSource): unknown[] | null {
  try {
    const value: unknown = JSON.parse(new TextDecoder().decode(data));
    return Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

interface GrantRace {
  events: string[];
  fired(): boolean;
  signs(): number;
  restore(): void;
}

interface GrantRaceOptions {
  passId: string;
  orgId: string;
  /** The capability signed for `passId` after which the clock advances (photo, then pass view). */
  occurrence: number;
  advance: number;
}

/** Use real WebCrypto, advancing the clock inside the nth capability MAC of one pass. */
export function clockDuringGrant(clock: ManualClock, options: GrantRaceOptions) {
  const nativeSign = crypto.subtle.sign.bind(crypto.subtle);
  const events: string[] = [];
  let signs = 0;
  let fired = false;
  const sign = vi.spyOn(crypto.subtle, 'sign').mockImplementation(async (algorithm, key, data) => {
    const fields = jsonArray(data);
    const capability =
      fields?.[0] === 'scan-asset-v3' && fields.includes('scan-asset-capability-v2');
    const result = await nativeSign(algorithm, key, data);
    if (capability && fields?.[4] === options.passId && ++signs === options.occurrence && !fired) {
      fired = true;
      events.push('clock advanced');
      clock.advance(options.advance);
    }
    return result;
  });
  return { events, fired: () => fired, signs: () => signs, restore: () => sign.mockRestore() };
}

/** Count the request separately from its real route guard and retain the final batch trace. */
export async function measured(
  post: Post,
  route: Route,
  body: Record<string, unknown>,
  options: {
    race?: Omit<GrantRaceOptions, 'orgId'>;
    beforeGrantBatch?: () => Promise<void>;
  } = {},
) {
  const real = kit.env.DB;
  const counted = countD1(real);
  let grantBatchAt: number | null = null;
  const traced = interceptBatches(counted.db, async (sql) => {
    if (grantBatchAt === null && isFinalFenceBatch(sql)) {
      grantBatchAt = kit.clock.now();
      await options.beforeGrantBatch?.();
    }
  });
  Object.assign(kit.env, { DB: traced.db });
  let race: GrantRace | undefined;
  try {
    expect((await post(route, {})).status).toBe(422);
    const guard = counted.count();
    counted.reset();
    clearSettingsCache(traced.db);
    if (options.race) race = clockDuringGrant(kit.clock, { ...options.race, orgId: kit.org.id });
    const response = await post(route, body);
    if (race) {
      if (!options.race) throw new Error('Missing grant race options');
      expect(race.fired()).toBe(true);
      expect(race.signs()).toBeGreaterThanOrEqual(options.race.occurrence);
    }
    expect(counted.count() - guard).toBeLessThanOrEqual(5);
    return { response, events: race?.events ?? [], grantBatchAt, trips: counted.count() - guard };
  } finally {
    race?.restore();
    Object.assign(kit.env, { DB: real });
  }
}
