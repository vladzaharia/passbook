import { expect, vi } from 'vitest';
import { countD1, makeUser } from '../../../../test/helpers/index.ts';
import { createApp } from '../../app.ts';
import { denyAllStores } from '../../platform/auth.ts';
import type { ManualClock } from '../../platform/clock.ts';
import { fromBase64Url, toBase64Url } from '../../platform/ids.ts';
import { insertSession } from '../auth/repo-sessions.ts';
import { createSessionStore, hashSessionCookie } from '../auth/sessions.ts';
import { putMemberPhoto } from '../passes/member-photo.ts';
import { clearSettingsCache } from '../settings/service.ts';
import { makePng } from '../templates/package/fixtures.ts';
import { interceptBatches, kit, templateId } from './lookup-output-test-fixtures.ts';
import { setPhotoGroup } from './repo-lookup-output-test-fixtures.ts';
import { countAssetGrants, hasAssetGrantInsert } from './repo-read-grant-expiry-test-fixtures.ts';
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

function scannerProofFrame(data: BufferSource, scannerId: string): boolean {
  const bytes = ArrayBuffer.isView(data)
    ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
    : new Uint8Array(data);
  if (bytes.length < 4) return false;
  const size = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0);
  return (
    size <= bytes.length - 4 && new TextDecoder().decode(bytes.subarray(4, 4 + size)) === scannerId
  );
}

// The Worker targets ES2023; its test runtime provides Promise.withResolvers.
const deferred = Promise as PromiseConstructor & {
  withResolvers<T>(): { promise: Promise<T>; resolve: (value: T) => void };
};

interface GrantRace {
  events: string[];
  fired(): boolean;
  snapshots(): number;
  restore(): void;
}

interface GrantRaceOptions {
  passId: string;
  orgId: string;
  snapshotOccurrence: number;
  advance: number;
  firstPhotoId?: string;
  staggerAdvance?: number;
  scannerId?: string;
}

/** Use real WebCrypto, delaying one photo MAC and advancing inside the later insert-guard proof. */
export function clockDuringGrant(clock: ManualClock, options: GrantRaceOptions) {
  const nativeSign = crypto.subtle.sign.bind(crypto.subtle);
  const nativeDigest = crypto.subtle.digest.bind(crypto.subtle);
  const events: string[] = [];
  let snapshots = 0;
  let fired = false;
  let firstToken: string | null = null;
  let firstSnapshots = 0;
  let firstGuardProof = false;
  let firstGuardSignalled = false;
  const firstPhoto = deferred.withResolvers<void>();
  const firstGuard = deferred.withResolvers<void>();
  const digest = vi.spyOn(crypto.subtle, 'digest').mockImplementation(async (algorithm, data) => {
    const result = await nativeDigest(algorithm, data);
    if (firstToken && new TextDecoder().decode(data) === firstToken) {
      firstToken = null;
      // Complete the early capability before allowing the second photo's real MAC to start.
      setTimeout(() => {
        events.push('first photo prepared');
        firstPhoto.resolve();
      }, 0);
    }
    return result;
  });
  const sign = vi.spyOn(crypto.subtle, 'sign').mockImplementation(async (algorithm, key, data) => {
    const fields = jsonArray(data);
    const capability =
      fields?.[0] === 'scan-asset-v3' && fields.includes('scan-asset-capability-v1');
    const marker = capability ? fields.indexOf('scan-asset-capability-v1') : -1;
    const isPhoto = marker >= 0 && fields?.[marker + 2] === 'photo';
    const passId = capability ? fields?.[4] : undefined;
    if (options.firstPhotoId && isPhoto && passId === options.passId) {
      await firstPhoto.promise;
      events.push('second photo signing');
    }
    const isSnapshot =
      fields?.[0] === options.passId && fields[1] === options.orgId && fields.length > 35;
    const occurrence = isSnapshot ? ++snapshots : 0;
    const firstOccurrence =
      options.firstPhotoId &&
      fields?.[0] === options.firstPhotoId &&
      fields[1] === options.orgId &&
      fields.length > 35
        ? ++firstSnapshots
        : 0;
    if (options.firstPhotoId && options.staggerAdvance && occurrence === 1) {
      await firstPhoto.promise;
      clock.advance(options.staggerAdvance);
      events.push('clock staggered');
    }
    if (options.firstPhotoId && options.scannerId && occurrence === options.snapshotOccurrence)
      await firstGuard.promise;
    const result = await nativeSign(algorithm, key, data);
    if (firstOccurrence === 2) firstGuardProof = true;
    if (
      firstGuardProof &&
      !firstGuardSignalled &&
      options.scannerId &&
      scannerProofFrame(data, options.scannerId)
    ) {
      firstGuardSignalled = true;
      // Let the early guard finish its verified CSRF snapshot and return its plan first.
      setTimeout(() => {
        events.push('first guard prepared');
        firstGuard.resolve();
      }, 0);
    }
    if (options.firstPhotoId && isPhoto && passId === options.firstPhotoId && fields) {
      const nonce = fromBase64Url(String(fields[fields.length - 1]));
      const bytes = new Uint8Array(nonce.length + 24);
      bytes.set(nonce);
      bytes.set(new Uint8Array(result).subarray(0, 24), nonce.length);
      firstToken = toBase64Url(bytes);
    }
    if (occurrence === options.snapshotOccurrence && !fired) {
      fired = true;
      events.push('clock advanced');
      clock.advance(options.advance);
    }
    return result;
  });
  return {
    events,
    fired: () => fired,
    snapshots: () => snapshots,
    restore() {
      sign.mockRestore();
      digest.mockRestore();
    },
  };
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
    if (grantBatchAt === null && hasAssetGrantInsert(sql)) {
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
      expect(race.snapshots()).toBeGreaterThanOrEqual(options.race.snapshotOccurrence);
    }
    expect(counted.count() - guard).toBeLessThanOrEqual(5);
    return { response, events: race?.events ?? [], grantBatchAt, trips: counted.count() - guard };
  } finally {
    race?.restore();
    Object.assign(kit.env, { DB: real });
  }
}

export async function grants() {
  return countAssetGrants(kit.env.DB, kit.org.id);
}
