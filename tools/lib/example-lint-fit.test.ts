import { describe, expect, it } from 'vitest';
import { localHour } from './example-canon.ts';
import { errorCodeFor } from './example-fields.ts';
import { exampleFailures } from './example-lint.ts';
import { familyOf, SENTENCE_HOME, SENTENCES } from './example-text.ts';
import type { Doc } from './openapi-diff.ts';

/** A document with one key-callable operation per response example, each with its `x-codes`. */
const docWith = (examples: Record<string, { value: unknown; codes?: string[] }>): Doc => ({
  paths: Object.fromEntries(
    Object.entries(examples).map(([id, { value, codes }]) => [
      `/${id}`,
      {
        get: {
          operationId: id,
          security: [{ apiKey: [] }],
          'x-codes': codes ?? [],
          responses: { '200': { content: { 'application/json': { schema: {}, example: value } } } },
        },
      },
    ]),
  ),
  components: { schemas: {} },
});
const run = (op: string, value: unknown, codes?: string[]): string[] =>
  exampleFailures(docWith({ [op]: { value, codes } }));

describe('the family sentences', () => {
  it('hold each sentence once, so every sentence has one home', () => {
    const all = Object.values(SENTENCES).flatMap((pools) => Object.values(pools).flat());
    expect(all.length).toBe(new Set(all).size);
    expect(SENTENCE_HOME.size).toBe(all.length);
  });

  it('put rollouts in their own family and the rest of an operation in its tag’s', () => {
    expect(familyOf('templates.getTemplatesByIdRollout')).toBe('rollouts');
    expect(familyOf('templates.getTemplatesById')).toBe('templates');
    expect(familyOf('scan-events.getScanEvents')).toBe('scan');
    expect(familyOf('broadcasts.getBroadcasts')).toBe('messages');
    expect(familyOf('unknown.getThing')).toBe('org');
  });
});

describe('fitFailures', () => {
  it('accepts a sentence in its own family and field', () => {
    expect(
      run('broadcasts.getBroadcastsById', { message: 'The gym closes at 18:00 on 24 December.' }),
    ).toEqual([]);
  });

  it('rejects a sentence written for another family', () => {
    expect(
      run('templates.getTemplatesUploadsById', {
        report: { issues: [{ message: 'The gym closes at 18:00 on 24 December.' }] },
      }),
    ).toEqual([
      'templates.getTemplatesUploadsById response.report.issues[0].message: "The gym closes at 18:00 on 24 December." was written for messages, not templates',
    ]);
  });

  it('rejects a sentence in a field it was not written for', () => {
    expect(
      run('broadcasts.getBroadcastsById', { note: 'The gym closes at 18:00 on 24 December.' }),
    ).toEqual([
      'broadcasts.getBroadcastsById response.note: "The gym closes at 18:00 on 24 December." was written for message, not note',
    ]);
  });

  it('rejects free text no family wrote, and leaves codes and single words alone', () => {
    expect(run('passes.postPassesByIdVoid', { reason: 'Left the gym early.' })).toEqual([
      'passes.postPassesByIdVoid response.reason: "Left the gym early." is free text no family wrote (tools/lib/example-text.ts)',
    ]);
    expect(run('scan.getScanSummary', { byReason: [{ reason: 'already_done' }] })).toEqual([]);
    expect(run('scan.getScanLive', { rows: [{ text: 'Today' }] })).toEqual([]);
  });

  it('rejects an error code the operation cannot carry, and accepts its own and its resource’s', () => {
    const codes = { 'webhooks.getWebhookEndpointsById': { value: {}, codes: ['UNSAFE_URL'] } };
    const doc = (code: string) =>
      exampleFailures(
        docWith({
          ...codes,
          'webhooks.getWebhookEndpointsByIdTests': { value: { errorCode: code } },
        }),
      );
    expect(doc('UPSTREAM_ERROR')).toEqual([
      'webhooks.getWebhookEndpointsByIdTests response.errorCode: error code UPSTREAM_ERROR is not one webhooks.getWebhookEndpointsByIdTests can carry',
    ]);
    // A sibling route's code, and a code the family stores on its records (webhooks/deliver.ts).
    expect(doc('UNSAFE_URL')).toEqual([]);
    expect(doc('TIMEOUT')).toEqual([]);
  });

  it('picks a failure code the operation can carry, never a caller code', () => {
    const doc = docWith({
      'pass-imports.getPassImportsById': {
        value: {},
        codes: ['FORBIDDEN', 'IMPORT_NOT_FOUND', 'IMPORT_FILE_GONE'],
      },
    });
    expect(errorCodeFor(doc, 'pass-imports.getPassImportsById')).toBe('IMPORT_FILE_GONE');
  });

  it('rejects an error on a record that finished well', () => {
    expect(
      run('templates.getTemplatesUploadsById', { status: 'complete', error: 'NOT_A_ZIP' }),
    ).toEqual([
      'templates.getTemplatesUploadsById response.error: a complete record carries the error NOT_A_ZIP',
    ]);
    expect(
      run('templates.getTemplatesUploadsById', { status: 'errored', error: 'NOT_A_ZIP' }),
    ).toEqual([]);
  });

  it('rejects hour bins that are not local hours in order', () => {
    const bin = (h: number, label: string) => ({
      start: localHour(h),
      label,
      count: 4,
      refused: 0,
    });
    const zone = { timeZone: 'America/Los_Angeles' };
    expect(
      run('scan.getScanSummary', { ...zone, byHour: [bin(6, '06:00'), bin(17, '17:00')] }),
    ).toEqual([]);
    expect(
      run('scan.getScanSummary', {
        ...zone,
        byHour: [
          bin(17, '17:00'),
          bin(6, '9 AM'),
          { start: 37, label: '06:00', count: 1, refused: 2 },
        ],
      }),
    ).toEqual([
      'scan.getScanSummary response.byHour[2].start: time 37 is not a plausible millisecond time',
      'scan.getScanSummary response.byHour[1]: hour bins are not in order, oldest first',
      'scan.getScanSummary response.byHour[1]: hour label "9 AM" is not HH:00',
      'scan.getScanSummary response.byHour[2]: more refused than scanned in the hour',
    ]);
    expect(run('scan.getScanSummary', { ...zone, byHour: [bin(6, '14:00')] })).toEqual([
      'scan.getScanSummary response.byHour[0]: hour label 14:00 is not the local hour of its start in America/Los_Angeles',
    ]);
  });

  it('reads from, to and start as times, and clearAfter as a duration', () => {
    expect(run('scan.getScanSummary', { from: 23, to: 39 })).toEqual([
      'scan.getScanSummary response.from: time 23 is not a plausible millisecond time',
      'scan.getScanSummary response.to: time 39 is not a plausible millisecond time',
    ]);
    expect(run('broadcasts.getBroadcastsById', { clearAfter: 604_800_000 })).toEqual([]);
  });

  it('rejects a state change whose own time is null: archive, void, close, revoke', () => {
    expect(
      run('nfc-tags.postNfcTagTypesByIdArchive', { name: 'Member wristband', archivedAt: null }),
    ).toEqual([
      'nfc-tags.postNfcTagTypesByIdArchive response.archivedAt: postNfcTagTypesByIdArchive answers with archivedAt null',
    ]);
    expect(run('api-keys.postApiKeysByIdRevoke', { key: { revokedAt: null } })).toEqual([
      'api-keys.postApiKeysByIdRevoke response.key.revokedAt: postApiKeysByIdRevoke answers with revokedAt null',
    ]);
    expect(run('org-lifecycle.postOrgsByOrgIdClose', { closedAt: 1795572000000 })).toEqual([]);
    // Undoing a state clears its time: an unvoid is not a void.
    expect(run('passes.postPassesByIdUnvoid', { voidedAt: null })).toEqual([]);
  });

  it('rejects a person with someone else’s email, and an ok sweep that was not verified', () => {
    expect(
      run('users.getUsers', { items: [{ name: 'Tomas Ortega', primaryEmail: 'ada@example.com' }] }),
    ).toEqual([
      "users.getUsers response.items[0].primaryEmail: Tomas Ortega has the email ada@example.com; a person's email is their own",
    ]);
    expect(
      run('users.getUsers', {
        items: [{ name: 'Sam Rivera', primaryEmail: 'sam.rivera@example.com' }],
      }),
    ).toEqual([]);
    expect(
      run('scan-staff.getScanStaff', { hostName: 'Sam Rivera', hostEmail: 'priya@example.com' }),
    ).toEqual([
      "scan-staff.getScanStaff response.hostEmail: Sam Rivera has the email priya@example.com; a person's email is their own",
    ]);
    expect(
      run('retention.getOrgsByOrgIdRetentionReceipts', { cls: 'ok', verified: false }),
    ).toEqual([
      'retention.getOrgsByOrgIdRetentionReceipts response.verified: an ok sweep is not verified',
    ]);
    expect(run('retention.getOrgsByOrgIdRetentionReceipts', { cls: 'ok', verified: true })).toEqual(
      [],
    );
  });

  it('rejects a scanning session named after a person', () => {
    expect(run('scan.getScanSession', { workspace: { session: { name: 'Sam Rivera' } } })).toEqual([
      'scan.getScanSession response.workspace.session.name: the scanning session is named after a person (Sam Rivera); name it for a place or shift',
    ]);
    expect(
      run('scan.getScanSession', { workspace: { session: { name: 'Evening shift' } } }),
    ).toEqual([]);
    expect(run('scanners.getScanningSessions', { items: [{ name: 'Priya Nair' }] })).toEqual([
      'scanners.getScanningSessions response.items[0].name: the scanning session is named after a person (Priya Nair); name it for a place or shift',
    ]);
  });
});
