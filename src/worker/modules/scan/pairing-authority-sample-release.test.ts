import { beforeAll, describe, expect, it } from 'vitest';
import { makeOrg, makeSession, makeUser, persistTemplate } from '../../../../test/helpers/index.ts';
import { first, run } from '../../platform/db.ts';
import { ICON_PNG } from '../passes/pass-test-fixtures.ts';
import {
  atCommit,
  releaseId as initialReleaseId,
  kit,
  member,
  passState,
  request,
  scannerPath,
  scannerState,
  setupPairingAuthorityFixture,
  templateId,
} from './repo-pairing-authority-split-test-fixtures.ts';
import { approveScanReleases, grantScanMembership } from './test-kit.ts';

setupPairingAuthorityFixture();

let releaseId: string;

describe('pairing tenant authority', () => {
  beforeAll(() => {
    releaseId = initialReleaseId;
  });

  it('does not issue a sample when its approved release is superseded at commit', async () => {
    const actor = await member();
    const author = await member();
    const reviewer = await member();
    const authorHeaders = { ...author.session.headers, 'x-passbook-mode': 'test' };
    const reviewerHeaders = { ...reviewer.session.headers, 'x-passbook-mode': 'test' };
    const scope = { orgId: kit.org.id, mode: 'test', provider: 'apple' };
    const base = `/templates/${templateId}`;
    const candidateResponse = await request('POST', `${base}/candidates`, authorHeaders, {
      ...scope,
      version: (await kit.registry.resolve(templateId, 'v1')).version,
    });
    expect(candidateResponse.status).toBe(201);
    const candidate = (await candidateResponse.json()) as { id: string; candidateHash: string };
    const approvalResponse = await request(
      'POST',
      `${base}/candidates/${candidate.id}/approve`,
      reviewerHeaders,
      { ...scope, candidateHash: candidate.candidateHash },
    );
    expect(approvalResponse.status).toBe(201);
    const approval = (await approvalResponse.json()) as { id: string };
    const scanner = await kit.scanner({ mode: 'test', templateIds: [templateId] });
    const beforeScanner = await scannerState(scanner.id);
    const beforePass = await passState();
    const previousRelease = releaseId;
    const response = await atCommit(
      'pass',
      async () => {
        const replacement = await request('POST', `${base}/releases`, authorHeaders, {
          ...scope,
          candidateId: candidate.id,
          approvalId: approval.id,
          candidateHash: candidate.candidateHash,
          expectedGeneration: 1,
        });
        expect(replacement.status).toBe(201);
        releaseId = ((await replacement.json()) as { id: string }).id;
      },
      () => request('POST', scannerPath(scanner.id, 'sample-pass'), actor.session.headers),
    );
    expect(releaseId).not.toBe(previousRelease);
    expect([409, 412]).toContain(response.status);
    expect(await scannerState(scanner.id)).toEqual(beforeScanner);
    expect(await passState()).toEqual(beforePass);
  }, 60_000);

  it('uses the approved release version and sample instead of the legacy version pointer', async () => {
    const actor = await member();
    const approved = await kit.registry.resolve(templateId, 'v1');
    const draft = kit.registry.add({
      id: templateId,
      orgId: kit.org.id,
      version: 'newer-draft',
      manifest: { ...approved.manifest, sample: { memberName: 'Unapproved draft' } },
      passJson: approved.passJson,
      assets: { 'icon.png': ICON_PNG },
    });
    await persistTemplate(kit.fx, draft, { registry: kit.registry });
    try {
      for (const legacyVersion of [draft.version, null]) {
        await run(kit.env.DB, 'UPDATE templates SET active_version = ? WHERE id = ?', [
          legacyVersion,
          templateId,
        ]);
        const scanner = await kit.scanner({ mode: 'test', templateIds: [templateId] });
        const response = await request(
          'POST',
          scannerPath(scanner.id, 'sample-pass'),
          actor.session.headers,
        );
        expect(response.status).toBe(201);
        const { passId } = (await response.json()) as { passId: string };
        const pass = await first<{
          template_version: string;
          personalization: string;
          release_id: string;
        }>(
          kit.env.DB,
          'SELECT template_version, personalization, release_id FROM passes WHERE id = ?',
          [passId],
        );
        expect(pass?.template_version).toBe(approved.version);
        expect(pass?.release_id).toBe(releaseId);
        expect(JSON.parse(pass?.personalization ?? '{}')).toEqual(approved.manifest.sample);
      }
    } finally {
      await run(kit.env.DB, 'UPDATE templates SET active_version = ? WHERE id = ?', [
        approved.version,
        templateId,
      ]);
    }
  }, 60_000);

  it('issues a sample from an organization-approved global Test release', async () => {
    const actor = await member();
    const base = await kit.registry.resolve(templateId, 'v1');
    const global = kit.registry.add({
      id: kit.fx.ids.id(),
      orgId: null,
      manifest: base.manifest,
      passJson: base.passJson,
      assets: { 'icon.png': ICON_PNG },
    });
    await persistTemplate(kit.fx, global, { registry: kit.registry });
    await approveScanReleases(kit, global.id, { modes: ['test'], orgId: kit.org.id });
    await run(kit.env.DB, 'UPDATE templates SET active_version=NULL WHERE id=?', [global.id]);
    const scanner = await kit.scanner({ mode: 'test', templateIds: [global.id] });
    const response = await request(
      'POST',
      scannerPath(scanner.id, 'sample-pass'),
      actor.session.headers,
    );
    expect(response.status).toBe(201);
    const sample = (await response.json()) as { passId: string; templateId: string };
    expect(sample.templateId).toBe(global.id);
    expect(
      await first(
        kit.env.DB,
        'SELECT org_id,mode,template_id,template_version FROM passes WHERE id=?',
        [sample.passId],
      ),
    ).toEqual({
      org_id: kit.org.id,
      mode: 'test',
      template_id: global.id,
      template_version: global.version,
    });
    const otherOrg = await makeOrg(kit.fx);
    const otherUser = await makeUser(kit.fx);
    await grantScanMembership(kit.fx, otherOrg.id, otherUser.id);
    const otherSession = await makeSession(kit.fx, { userId: otherUser.id });
    const otherScanner = await kit.scanner({
      orgId: otherOrg.id,
      mode: 'test',
      templateIds: [global.id],
    });
    const beforePass = await passState();
    const denied = await request(
      'POST',
      scannerPath(otherScanner.id, 'sample-pass'),
      otherSession.headers,
    );
    expect([409, 422]).toContain(denied.status);
    expect(await passState()).toEqual(beforePass);
  }, 60_000);

  it('issues a test sample with an authorized tenant session', async () => {
    const actor = await member();
    const scanner = await kit.scanner({ mode: 'test', templateIds: [templateId] });
    const response = await request(
      'POST',
      scannerPath(scanner.id, 'sample-pass'),
      actor.session.headers,
    );
    expect(response.status).toBe(201);
    const sample = (await response.json()) as { passId: string; templateId: string };
    expect(sample.templateId).toBe(templateId);
    expect(
      await first(kit.env.DB, 'SELECT mode, holder_email, release_id FROM passes WHERE id = ?', [
        sample.passId,
      ]),
    ).toEqual({
      mode: 'test',
      holder_email: null,
      release_id: releaseId,
    });
  }, 60_000);
});
