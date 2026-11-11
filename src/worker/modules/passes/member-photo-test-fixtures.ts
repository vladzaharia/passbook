import { unzipSync } from 'fflate';
import { makeSession, makeUser } from '../../../../test/helpers/index.ts';
import { createApp } from '../../app.ts';
import { denyAllStores } from '../../platform/auth.ts';
import { createApiKeyStore } from '../api-keys/service.ts';
import { createSessionStore } from '../auth/sessions.ts';
import { makePng } from '../templates/package/fixtures.ts';
import { grantKitMembership } from './apple-release-test-fixtures.ts';
import { expectValidZip, type Kit, setupKit } from './pass-test-fixtures.ts';
import { getPass } from './repo-read-pass.ts';

const ORIGIN = 'https://wallet.test';
export const actor = { type: 'system' as const, id: null };
export const png = makePng(270, 270);
export const encoded = btoa(String.fromCharCode(...png));

export interface MemberPhotoFixture {
  kit: Kit;
  adminMembershipId: string;
  adminHeaders: Record<string, string>;
  userHeaders: Record<string, string>;
  api(
    id: string,
    method?: string,
    body?: unknown,
    headers?: Record<string, string>,
  ): Promise<Response>;
  get(path: string, headers?: Record<string, string>): Promise<Response>;
  files(id: string): Promise<Record<string, Uint8Array>>;
}

export async function setupPhotoTestKit(): Promise<MemberPhotoFixture> {
  const kit = await setupKit();
  const adminMembershipId = await grantKitMembership(kit);
  const admin = await makeSession(kit.fx, { userId: 'admin-1', roles: ['admin', 'user'] });
  const user = await makeUser(kit.fx);
  const ordinary = await makeSession(kit.fx, { userId: user.id });
  const adminHeaders = { ...admin.headers, origin: ORIGIN };
  const userHeaders = { ...ordinary.headers, origin: ORIGIN };
  const app = createApp({
    stores: {
      ...denyAllStores,
      sessions: createSessionStore(kit.env, kit.clock),
      apiKeys: createApiKeyStore(kit.env, kit.clock),
    },
    clock: kit.clock,
  });
  const api = async (id: string, method = 'GET', body?: unknown, headers = adminHeaders) =>
    app.request(
      `${ORIGIN}/api/v1/passes/${id}/member-photo`,
      {
        method,
        headers: { ...headers, 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      },
      kit.env,
    );
  const get = async (path: string, headers: Record<string, string> = {}) =>
    app.request(`${ORIGIN}${path}`, { headers }, kit.env);
  async function files(id: string) {
    const pass = await getPass(kit.env.DB, id);
    const object = await kit.env.BUCKET.get(pass?.objectKey ?? '');
    if (!object) throw new Error('Pass object is missing');
    const bytes = new Uint8Array(await object.arrayBuffer());
    expectValidZip(bytes);
    return unzipSync(bytes);
  }
  return { kit, adminMembershipId, adminHeaders, userHeaders, api, get, files };
}
