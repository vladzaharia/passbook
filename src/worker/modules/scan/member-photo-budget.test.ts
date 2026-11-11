import { describe, expect, it } from 'vitest';
import { countD1 } from '../../../../test/helpers/index.ts';
import type { ScanOutcome } from '../../../shared/contracts/scan.ts';
import { putPassCheckIn } from '../passes/check-in.ts';
import { ensureCredentialRefKeyset } from '../passes/credential-keyset.ts';
import { putMemberPhoto } from '../passes/member-photo.ts';
import { clearSettingsCache } from '../settings/service.ts';
import { makePng } from '../templates/package/fixtures.ts';
import { assetActorFor } from './asset-test-fixtures.ts';
import { confirmedPhotoUrl, knownPhotoUrl } from './member-photo.ts';
import { prepareAssetGrantInsertion } from './repo-asset-grants.ts';
import { candidateById } from './repo-lookup.ts';
import { codeOf, key, setupScanKit } from './test-kit.ts';

const bytes = makePng(270, 270);
const png = btoa(String.fromCharCode(...bytes));

describe('scanner member photo D1 budget', () => {
  it('keeps a cold photo check-in with prior history within five post-guard D1 trips', async () => {
    const scoped = await setupScanKit();
    await ensureCredentialRefKeyset(scoped.env.DB, scoped.env);
    const templateId = await scoped.scanTemplate('Cold photo history', {
      actions: [{ id: 'check_in', label: 'Check in', kind: 'check_in' }],
    });
    const scanner = await scoped.scanner({ templateIds: [templateId] });
    const pass = await scoped.scanPass(templateId);
    await putPassCheckIn(
      scoped.ctx,
      { type: 'system', id: null },
      pass.id,
      { mode: 'in_out' },
      null,
    );
    const request = () =>
      scoped.post(scanner.headers, '/actions', {
        idempotencyKey: key(),
        input: codeOf(pass),
        actionId: 'auto',
        clientTs: scoped.clock.now(),
      });
    expect(((await (await request()).json()) as ScanOutcome).kind).toBe('ok');
    await putMemberPhoto(
      scoped.ctx,
      { type: 'system', id: null },
      pass.id,
      { png, includeInPass: false },
      null,
    );
    const real = scoped.env.DB;
    const counted = countD1(real);
    Object.assign(scoped.env, { DB: counted.db });
    try {
      await scoped.post(scanner.headers, '/actions', {});
      const guard = counted.count();
      counted.reset();
      clearSettingsCache(counted.db);
      const response = await request();
      expect(response.status).toBe(200);
      const outcome = (await response.json()) as ScanOutcome;
      expect(outcome.kind).toBe('ok');
      expect(outcome.display?.identity.photo?.url).toContain(
        `/passes/${pass.id}/assets/member.png?g=`,
      );
      expect(counted.count() - guard).toBeLessThanOrEqual(5);
    } finally {
      Object.assign(scoped.env, { DB: real });
    }
  });
  it('redeems a private photo within five post-guard D1 trips', async () => {
    const scoped = await setupScanKit();
    await ensureCredentialRefKeyset(scoped.env.DB, scoped.env);
    const templateId = await scoped.scanTemplate('Cold photo redemption', {
      actions: [{ id: 'check_in', label: 'Check in', kind: 'check_in' }],
    });
    const scanner = await scoped.scanner({ templateIds: [templateId] });
    const pass = await scoped.scanPass(templateId);
    await putMemberPhoto(
      scoped.ctx,
      { type: 'system', id: null },
      pass.id,
      { png, includeInPass: false },
      null,
    );
    const actor = await assetActorFor(scoped, scanner);
    const candidate = await candidateById(scoped.env.DB, scoped.org.id, pass.id);
    if (!candidate) throw new Error('Photo candidate missing');
    const pinned = await scoped.registry.resolve(templateId, candidate.pass.templateVersion);
    const prepared = await knownPhotoUrl(scoped.ctx, actor, candidate, pinned);
    if (!prepared) throw new Error('Photo grant plan missing');
    const bind = await prepareAssetGrantInsertion(scoped.ctx, prepared.grant, undefined, candidate);
    const results = await scoped.env.DB.batch(bind(scoped.clock.now(), undefined));
    const url = confirmedPhotoUrl(actor, pass.id, prepared.grant, results);
    if (!url) throw new Error('Confirmed photo URL missing');
    const real = scoped.env.DB;
    const counted = countD1(real);
    Object.assign(scoped.env, { DB: counted.db });
    try {
      await scoped.post(scanner.headers, '/actions', {});
      const guard = counted.count();
      counted.reset();
      const image = await scoped.get(scanner.headers, url.replace('/api/v1/scan', ''));
      expect(image.status).toBe(200);
      expect(new Uint8Array(await image.arrayBuffer())).toEqual(bytes);
      expect(counted.count() - guard).toBeLessThanOrEqual(5);
    } finally {
      Object.assign(scoped.env, { DB: real });
    }
  });
});
