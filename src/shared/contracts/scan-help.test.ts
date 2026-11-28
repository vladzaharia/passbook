import { describe, expect, it } from 'vitest';
import { ScanActionApprovalSchema, ScanUndoApprovalSchema } from './scan-base.ts';
import {
  SCAN_HELP_ERROR_CODES,
  SCAN_HELP_ERROR_STATUS,
  SCAN_REACH_FRESH_ACTIONS,
  ScanApproversQuerySchema,
  ScanHelpAdminResolveSchema,
  ScanHelpRaiseSchema,
  ScanHelpResolveSchema,
  ScanHelpTopicSchema,
  ScanReachPinSchema,
} from './scan-help.ts';
import { SCAN_HELP_WEBHOOK_DATA, SCAN_HELP_WEBHOOK_EVENTS } from './scan-help-events.ts';

const ID = '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b';
const HASH = 'a'.repeat(64);

describe('scan help contract', () => {
  it('names every error code once, each with a status', () => {
    expect(new Set(SCAN_HELP_ERROR_CODES).size).toBe(SCAN_HELP_ERROR_CODES.length);
    for (const code of [
      'HELP_NOT_NEEDED',
      'HELP_TAKEN',
      'HELP_EXPIRED',
      'HELP_STALE',
      'APPROVAL_PIN_REQUIRED',
      'APPROVAL_GRANT_INVALID',
      'APPROVE_AS_NOT_ALLOWED',
      'STAFF_REAUTH',
      'REACH_CONFIRM_REQUIRED',
      'KIOSK_NOT_ALLOWED',
      'SIGN_IN_ROLE_NOT_ALLOWED',
      'SIGN_IN_NOT_THIS_DEVICE',
    ] as const)
      expect(SCAN_HELP_ERROR_CODES).toContain(code);
    expect(Object.keys(SCAN_HELP_ERROR_STATUS).sort()).toEqual([...SCAN_HELP_ERROR_CODES].sort());
  });

  it('has the approve_as_review topic and the fresh reach actions', () => {
    expect(ScanHelpTopicSchema.parse('approve_as_review')).toBe('approve_as_review');
    expect(SCAN_REACH_FRESH_ACTIONS).toEqual([
      'approve',
      'deny',
      'remote_undo',
      'remote_sign_out',
      'kiosk_pause',
      'kiosk_resume',
    ]);
  });

  it('takes one approval form at a time', () => {
    expect(ScanActionApprovalSchema.safeParse({ pin: '123456', alone: true }).success).toBe(true);
    expect(ScanActionApprovalSchema.safeParse({ requestId: ID }).success).toBe(true);
    expect(ScanActionApprovalSchema.safeParse({ approveAs: ID }).success).toBe(true);
    expect(ScanActionApprovalSchema.safeParse({ requestId: ID, pin: '123456' }).success).toBe(
      false,
    );
    expect(ScanUndoApprovalSchema.safeParse({ pin: '123456', alone: true }).success).toBe(false);
    expect(ScanUndoApprovalSchema.safeParse({ requestId: ID }).success).toBe(true);
  });

  it('validates a raise', () => {
    const base = { idempotencyKey: ID };
    expect(
      ScanHelpRaiseSchema.safeParse({ ...base, kind: 'help', topic: 'scanner_help' }).success,
    ).toBe(true);
    expect(
      ScanHelpRaiseSchema.safeParse({
        ...base,
        kind: 'approval',
        topic: 'undo',
        undo: { scanId: ID },
      }).success,
    ).toBe(true);
    expect(ScanHelpRaiseSchema.safeParse({ ...base, kind: 'approval', topic: 'act' }).success).toBe(
      false,
    );
    expect(ScanHelpRaiseSchema.safeParse({ ...base, kind: 'help', topic: 'nope' }).success).toBe(
      false,
    );
  });

  it('takes a deny reason only on a deny', () => {
    const base = { version: 1, idempotencyKey: ID };
    expect(
      ScanHelpResolveSchema.safeParse({ ...base, outcome: 'denied', denyReason: 'see_desk' })
        .success,
    ).toBe(true);
    expect(
      ScanHelpResolveSchema.safeParse({ ...base, outcome: 'approved', denyReason: 'other' })
        .success,
    ).toBe(false);
    expect(ScanHelpAdminResolveSchema.safeParse({ outcome: 'approved' }).success).toBe(false);
  });

  it('checks the approvers hash and reach PIN', () => {
    expect(ScanApproversQuerySchema.safeParse({ requestHash: HASH }).success).toBe(true);
    expect(ScanApproversQuerySchema.safeParse({ requestHash: 'abc' }).success).toBe(false);
    expect(ScanReachPinSchema.safeParse({}).success).toBe(true);
    expect(ScanReachPinSchema.safeParse({ pin: '1234' }).success).toBe(false);
  });

  it('has a data schema per webhook name', () => {
    expect(Object.keys(SCAN_HELP_WEBHOOK_DATA)).toEqual([...SCAN_HELP_WEBHOOK_EVENTS]);
    expect(
      SCAN_HELP_WEBHOOK_DATA['scanner.status_changed'].safeParse({
        scannerId: ID,
        sessionId: ID,
        deviceRole: 'kiosk',
        status: 'paused',
      }).success,
    ).toBe(true);
  });
});
