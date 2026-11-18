import { beforeAll, describe, expect, it } from 'vitest';
import { raceGate } from './act-authority-test-fixtures.ts';
import {
  CHECK_IN,
  kit,
  reviseReplayTemplate,
  rows,
  setupActionFixture,
} from './act-test-fixtures.ts';
import { bindTag, nextUid, tagInput, tagsOn } from './tags-resolve-test-fixtures.ts';
import { key } from './test-kit.ts';

beforeAll(async () => {
  await setupActionFixture();
  await tagsOn();
});

describe('a release that raises the tag minimum between read and commit', () => {
  it('refuses the /actions tap and records no check-in', async () => {
    const template = await kit.scanTemplate('Minimum race', { actions: [CHECK_IN] });
    const scanner = await kit.scanner({
      templateIds: [template],
      settings: { roleWithoutSignIn: 'desk' },
    });
    const pass = await kit.scanPass(template);
    const uid = nextUid();
    await bindTag(uid, pass);
    const response = await raceGate(
      scanner.headers,
      tagInput(uid),
      (db) =>
        reviseReplayTemplate(
          template,
          (manifest) => {
            manifest.scan = { ...manifest.scan, actions: [CHECK_IN], tags: { min: 'secure' } };
          },
          ['live'],
          db,
        ),
      { idempotencyKey: key() },
    );
    // The tag path's pass fence refuses a changed release before the policy check can admit.
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: 'SCAN_PASS_CHANGED' });
    expect(
      await rows("SELECT id FROM pass_events WHERE pass_id=? AND kind='scan.checked_in'", [
        pass.id,
      ]),
    ).toHaveLength(0);
  });
});
