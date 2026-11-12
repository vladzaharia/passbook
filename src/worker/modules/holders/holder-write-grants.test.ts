// Tenant holder writes (clear a block, record a reissue requirement) commit under the tenant's grant.
import { describe, expect, it } from 'vitest';
import { first, run } from '../../platform/db.ts';
import { createAuthStores } from '../../stores.ts';
import { jobCtxOf } from '../delivery/delivery-test-fixtures.ts';
import { type TenantPassWrite, tenantAuthorityOf } from '../passes/http.ts';
import type { Kit } from '../passes/pass-test-fixtures.ts';
import { fixedBarcodePass } from './fixed-barcode-test-fixtures.ts';
import { getHolderPass } from './repo.ts';
import { markHolderReissueGranted } from './repo-blocks.ts';
import { clearBlock } from './service.ts';
import { eventMember } from './test-auth-fixtures.ts';

const count = (kit: Kit, sql: string, id: string) =>
  first<{ n: number }>(kit.env.DB, sql, [id]).then((row) => row?.n);
const audits = (kit: Kit, id: string, action: string) =>
  count(
    kit,
    `SELECT count(*) AS n FROM audit_log WHERE action = '${action}' AND target_id = ?`,
    id,
  );
const blocks = (kit: Kit, id: string) =>
  count(kit, 'SELECT count(*) AS n FROM pass_attach_blocks WHERE pass_id = ?', id);
const markers = (kit: Kit, id: string) =>
  count(kit, 'SELECT count(*) AS n FROM pass_holder_reissue_required WHERE pass_id = ?', id);

async function blockedRetiredPass() {
  const fixture = await fixedBarcodePass({ retired: true });
  const { kit, pass, user } = fixture;
  await run(
    kit.env.DB,
    'INSERT INTO pass_attach_blocks (pass_id, user_id, created_at) VALUES (?, ?, ?)',
    [pass.id, user.id, kit.clock.now()],
  );
  return fixture;
}

async function memberAuthority(kit: Kit, capability: 'passes:operate' | 'passes:read') {
  const member = await eventMember(kit, kit.org.id, ['pass_operator']);
  const auth = await createAuthStores(kit.env).sessions.resolve(member.session.cookieValue);
  if (!auth) throw new Error('Missing session');
  return {
    member,
    authority: await tenantAuthorityOf(jobCtxOf(kit), auth, kit.org.id, capability),
  };
}

describe('tenant clear-block', () => {
  it('removes the block, audits it once and records the reissue requirement under the grant', async () => {
    const { kit, pass, user } = await blockedRetiredPass();
    const { member, authority } = await memberAuthority(kit, 'passes:operate');
    await clearBlock(
      jobCtxOf(kit),
      { type: 'user', id: member.user.id },
      { passId: pass.id, userId: user.id },
      null,
      async () => authority,
    );
    expect(await blocks(kit, pass.id)).toBe(0);
    expect(await audits(kit, pass.id, 'holder.clear_block')).toBe(1);
    expect(await markers(kit, pass.id)).toBe(1);
    expect(await audits(kit, pass.id, 'holder.attach_reissue_required')).toBe(1);
  }, 120_000);

  it('refuses an authority without the operate capability and leaves the block', async () => {
    const { kit, pass, user } = await blockedRetiredPass();
    const { member, authority } = await memberAuthority(kit, 'passes:read');
    await expect(
      clearBlock(
        jobCtxOf(kit),
        { type: 'user', id: member.user.id },
        { passId: pass.id, userId: user.id },
        null,
        async () => authority,
      ),
    ).rejects.toMatchObject({ code: 'BLOCK_NOT_FOUND' });
    expect(await blocks(kit, pass.id)).toBe(1);
    expect(await audits(kit, pass.id, 'holder.clear_block')).toBe(0);
  }, 120_000);

  it('refuses a snapshot that claims a capability the membership does not hold', async () => {
    const { kit, pass, user } = await blockedRetiredPass();
    const member = await eventMember(kit, kit.org.id, ['read_only']);
    const auth = await createAuthStores(kit.env).sessions.resolve(member.session.cookieValue);
    if (!auth) throw new Error('Missing session');
    const read = await tenantAuthorityOf(jobCtxOf(kit), auth, kit.org.id, 'passes:read');
    const forged = { ...read, capability: 'passes:operate' } as TenantPassWrite;
    await expect(
      clearBlock(
        jobCtxOf(kit),
        { type: 'user', id: member.user.id },
        { passId: pass.id, userId: user.id },
        null,
        async () => forged,
      ),
    ).rejects.toBeDefined();
    expect(await blocks(kit, pass.id)).toBe(1);
  }, 120_000);
});

describe('tenant reissue requirement', () => {
  const entry = (orgId: string, passId: string, userId: string) => ({
    orgId,
    actorType: 'system' as const,
    actorId: null,
    action: 'holder.attach_reissue_required',
    targetType: 'pass',
    targetId: passId,
    detail: { userId },
  });

  it('records once and does not audit an unchanged requirement again', async () => {
    const { kit, pass, user } = await fixedBarcodePass({ retired: true });
    const { authority } = await memberAuthority(kit, 'passes:operate');
    const source = await getHolderPass(kit.env.DB, pass.id, null);
    if (!source) throw new Error('Missing source');
    const keyset = (await first<{ commitment: string }>(
      kit.env.DB,
      'SELECT commitment FROM credential_ref_keyset WHERE id = 1',
    ))!.commitment;
    const mark = () =>
      markHolderReissueGranted(
        jobCtxOf(kit),
        pass.id,
        source,
        user.id,
        keyset,
        authority,
        undefined,
        entry(pass.orgId, pass.id, user.id),
      );
    await mark();
    await mark();
    expect(await markers(kit, pass.id)).toBe(1);
    expect(await audits(kit, pass.id, 'holder.attach_reissue_required')).toBe(1);
  }, 120_000);

  it('records nothing for a read-only authority', async () => {
    const { kit, pass, user } = await fixedBarcodePass({ retired: true });
    const { authority } = await memberAuthority(kit, 'passes:read');
    const source = await getHolderPass(kit.env.DB, pass.id, null);
    if (!source) throw new Error('Missing source');
    await markHolderReissueGranted(
      jobCtxOf(kit),
      pass.id,
      source,
      user.id,
      '0'.repeat(64),
      authority,
      undefined,
      entry(pass.orgId, pass.id, user.id),
    );
    expect(await markers(kit, pass.id)).toBe(0);
    expect(await audits(kit, pass.id, 'holder.attach_reissue_required')).toBe(0);
  }, 120_000);
});
