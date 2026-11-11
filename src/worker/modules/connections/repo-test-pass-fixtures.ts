import { makeTemplate, persistTemplate } from '../../../../test/helpers/index.ts';
import { run } from '../../platform/db.ts';
import { ensurePlatformIdentity } from '../identities/repo.ts';
import { PLATFORM_IDENTITY_ID } from '../identities/resolver.ts';
import type { Kit } from './test-kit.ts';

/** Seed authority at insertion; mode and holder cannot be changed directly afterward. */
export async function seedPass(
  kit: Kit,
  orgId: string,
  mode: 'live' | 'test',
  holder?: { ownerUserId: string; holderEmail: string },
  binding?: { connectionId: string; ref: string },
  reservedPassId?: string,
) {
  const template = makeTemplate({ id: kit.templateId, orgId }).resolved;
  await ensurePlatformIdentity(kit.env, kit.clock.now());
  await persistTemplate(kit, template);
  const id = reservedPassId ?? kit.ids.id();
  const pass = {
    id,
    orgId,
    serial: kit.ids.token(16),
    authToken: kit.ids.token(),
    downloadToken: kit.ids.token(),
    objectKey: `passes/${id}/v1-${kit.ids.token(4)}.pkpass`,
  };
  const now = kit.clock.now();
  await kit.env.BUCKET.put(pass.objectKey, new Uint8Array([1, 2, 3]));
  await run(
    kit.env.DB,
    `INSERT INTO passes
    (id, org_id, identity_id, serial, template_id, template_version, auth_token, download_token,
     web_service_url, personalization, object_key, modified_at, created_at, pending_cause, mode, owner_user_id, holder_email,
     connection_id, external_ref)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'create', ?, ?, ?, ?, ?)`,
    [
      id,
      orgId,
      PLATFORM_IDENTITY_ID,
      pass.serial,
      template.id,
      template.version,
      pass.authToken,
      pass.downloadToken,
      `${kit.env.PUBLIC_BASE_URL}/wallet`,
      JSON.stringify({ memberName: 'Alex Morgan' }),
      pass.objectKey,
      now,
      now,
      mode,
      holder?.ownerUserId ?? null,
      holder?.holderEmail ?? null,
      binding?.connectionId ?? null,
      binding?.ref ?? null,
    ],
  );
  return pass;
}
