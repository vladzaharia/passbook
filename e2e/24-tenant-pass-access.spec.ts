import { expect, test } from '@playwright/test';
import type { OrgMembership } from '../src/shared/contracts/org-membership.ts';
import type { PassDetailDto } from '../src/shared/contracts/passes.ts';
import type { SessionResponse } from '../src/shared/contracts/session.ts';
import { apiAs, GENERIC, requireActiveTemplateRelease, uid } from './helpers/api.ts';
import { addOrgMember, createOrgWithRoles } from './helpers/seed.ts';

test('a pass operator can issue only in an organization where they are a member', async () => {
  const admin = await apiAs('admin');
  try {
    const operator = await apiAs('user');
    let membershipToRevoke: { orgId: string; id: string } | undefined;
    try {
      const session = await operator.get<SessionResponse>('/api/v1/session');
      expect(session.authenticated).toBe(true);
      if (!session.authenticated) throw new Error('Expected an authenticated operator');
      expect(session.user.primaryEmail).toBe('user@example.test');
      expect(session.roles).toContain('user');
      expect(session.roles).not.toContain('admin');
      expect(session.csrfToken).not.toBe('');

      const memberSlug = uid('tenant-member').toLowerCase();
      const foreignSlug = uid('tenant-foreign').toLowerCase();
      const memberOrg = await createOrgWithRoles(admin, {
        slug: memberSlug,
        name: `Tenant member ${memberSlug}`,
      });
      const foreignOrg = await createOrgWithRoles(admin, {
        slug: foreignSlug,
        name: `Tenant foreign ${foreignSlug}`,
      });
      expect(memberOrg.id).not.toBe(foreignOrg.id);

      const membership = await addOrgMember(admin, memberOrg.id, operator, ['pass_operator']);
      membershipToRevoke = { orgId: memberOrg.id, id: membership.id };
      const memberships = await operator.get<{ items: OrgMembership[] }>(
        '/api/v1/orgs/memberships/me',
      );
      const relevantMemberships = memberships.items.filter(
        (item) => item.orgId === memberOrg.id || item.orgId === foreignOrg.id,
      );
      expect(relevantMemberships).toEqual([
        expect.objectContaining({
          id: membership.id,
          orgId: memberOrg.id,
          userId: session.user.id,
          roles: ['pass_operator'],
          capabilities: expect.arrayContaining(['passes:operate']),
          revokedAt: null,
        }),
      ]);

      const memberRelease = await requireActiveTemplateRelease(
        admin,
        memberOrg.id,
        GENERIC,
        'live',
      );
      const foreignRelease = await requireActiveTemplateRelease(
        admin,
        foreignOrg.id,
        GENERIC,
        'live',
      );
      const input = { holder: uid('Tenant guest'), memberId: uid('MEMBER').toUpperCase() };
      const issue = {
        templateId: GENERIC,
        releaseId: memberRelease.id,
        releaseGeneration: memberRelease.generation,
        templateVersion: memberRelease.version,
        mode: 'live',
        input,
      };
      const foreignIssue = {
        ...issue,
        releaseId: foreignRelease.id,
        releaseGeneration: foreignRelease.generation,
        templateVersion: foreignRelease.version,
      };
      const headers = { Origin: 'http://localhost:5173', 'X-CSRF-Token': session.csrfToken };
      const created = await operator.ctx.post('/api/v1/passes', {
        headers: { ...headers, 'Idempotency-Key': uid('tenant-issue') },
        data: { ...issue, orgId: memberOrg.id },
      });
      expect(created.status()).toBe(201);
      const pass = (await created.json()) as PassDetailDto;
      expect(pass).toMatchObject({
        id: expect.any(String),
        orgId: memberOrg.id,
        templateId: GENERIC,
        templateVersion: memberRelease.version,
        status: 'active',
        mode: 'live',
        title: input.holder,
        personalization: input,
      });
      expect(pass.id).not.toBe('');

      // The same session, CSRF token and valid input must be rejected for an org
      // where this operator has no membership, even with that org's active release.
      const denied = await operator.ctx.post('/api/v1/passes', {
        headers: { ...headers, 'Idempotency-Key': uid('tenant-denied') },
        data: { ...foreignIssue, orgId: foreignOrg.id },
      });
      expect(denied.status()).toBe(403);
      expect(await denied.json()).toMatchObject({ status: 403, code: 'FORBIDDEN' });

      // No foreign pass was written; an invited admin can issue the identical payload there.
      const foreignPasses = await admin.get<{ items: { id: string }[] }>(
        `/api/v1/passes?orgId=${encodeURIComponent(foreignOrg.id)}`,
      );
      expect(foreignPasses.items).toEqual([]);
      const control = await admin.send<PassDetailDto>(
        'POST',
        '/api/v1/passes',
        { ...foreignIssue, orgId: foreignOrg.id },
        { 'Idempotency-Key': uid('tenant-control') },
      );
      expect(control).toMatchObject({
        id: expect.any(String),
        orgId: foreignOrg.id,
        templateId: GENERIC,
        templateVersion: foreignRelease.version,
        status: 'active',
        mode: 'live',
        personalization: input,
      });

      // A previously authorized session loses both read and issuance access on revocation.
      await admin.send(
        'DELETE',
        `/api/v1/orgs/${encodeURIComponent(memberOrg.id)}/memberships/${encodeURIComponent(membership.id)}`,
      );
      membershipToRevoke = undefined;
      const revokedRead = await operator.ctx.get(`/api/v1/passes/${encodeURIComponent(pass.id)}`);
      expect(revokedRead.status()).toBe(403);
      const revokedIssue = await operator.ctx.post('/api/v1/passes', {
        headers: { ...headers, 'Idempotency-Key': uid('tenant-revoked') },
        data: { ...issue, orgId: memberOrg.id },
      });
      expect(revokedIssue.status()).toBe(403);
      expect(await revokedIssue.json()).toMatchObject({ status: 403, code: 'FORBIDDEN' });
      const memberPasses = await admin.get<{ items: { id: string }[] }>(
        `/api/v1/passes?orgId=${encodeURIComponent(memberOrg.id)}`,
      );
      expect(memberPasses.items).toEqual([expect.objectContaining({ id: pass.id })]);
    } finally {
      try {
        if (membershipToRevoke) {
          await admin.send(
            'DELETE',
            `/api/v1/orgs/${encodeURIComponent(membershipToRevoke.orgId)}/memberships/${encodeURIComponent(membershipToRevoke.id)}`,
          );
        }
      } finally {
        await operator.dispose();
      }
    }
  } finally {
    await admin.dispose();
  }
});
