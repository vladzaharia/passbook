import { describe, expect, it } from 'vitest';
import {
  captureHistoryProofSnapshot,
  type HistoryProofFence,
  historyProofSnapshotPredicates,
} from './repo-history-proof-cas.ts';
import { scanSecretSlots } from './repo-secret-binds.ts';

const ROW_KEYS = [
  'id',
  'org_id',
  'mode',
  'state',
  'outcome',
  'action_kind',
  'pass_version',
  'method',
  'at',
  'direction',
  'recorded_wallet_version',
  'current_pass_version',
  'current_pass_revision',
  'current_credential_generation',
  'current_lifecycle_generation',
  'current_image_generation',
  'current_link_generation',
  'current_connection_generation',
  'current_org_revision',
  'current_wallet_version',
  'current_identity_revision',
  'current_release_id',
  'current_release_generation',
  'current_release_hash',
  'ledger_id',
  'ledger_org_id',
  'ledger_mode',
  'ledger_kind',
  'ledger_actor_type',
  'ledger_at',
  'approved_proof',
  'legacy_proof',
  'pass_id',
  'template_id',
  'scanner_id',
  'event_id',
  'actor_key',
  'staff_id',
  'request_hash',
  'reason',
  'action_id',
  'override_of',
  'approved_by',
  'undone_by',
  'presence_scope',
  'amount',
  'before_value',
  'after_value',
  'ledger_pass_id',
  'ledger_device',
  'ledger_actor_id',
  'ledger_data',
  'recorded_wallet_template_version',
  'recorded_personalization',
  'recorded_template_version',
  'event_pinned_manifest',
  'event_wallet_manifest',
  'event_active_version',
  'event_active_manifest',
  'current_personalization',
  'current_title',
  'current_scanner_name',
  'current_pinned_version',
  'current_pinned_manifest',
  'current_active_version',
  'current_active_manifest',
  'current_identity_id',
  'current_connection_id',
  'pass_serial',
  'pass_auth_token',
  'pass_download_token',
  'pass_web_service_url',
  'pass_scan_code',
  'pass_external_id',
  'pass_holder_email',
  'current_wallet_private_values',
] as const;

function proof(wallet: string, projectionCurrent = true): HistoryProofFence {
  const row: Record<string, unknown> = Object.fromEntries(ROW_KEYS.map((key) => [key, 'value']));
  Object.assign(row, {
    id: 'scan',
    pass_serial: 'serial-private',
    pass_auth_token: 'auth-private',
    current_personalization: '{"copy":"auth-private"}',
    current_wallet_private_values: wallet,
  });
  const snapshot = captureHistoryProofSnapshot(row, 'a'.repeat(64));
  if (!snapshot) throw new Error('Missing history snapshot');
  return {
    scan: { id: 'scan', eventId: null },
    projectionCurrent,
    credentialKeysetCommitment: 'a'.repeat(64),
    snapshot,
  };
}

describe('history proof binding limits', () => {
  it('splits exact sensitive values into bounded labeled fragments without JSON-packing them', () => {
    const snapshot = proof(`["wallet-private", "${'🙂'.repeat(200_000)}"]`);
    const fragments = historyProofSnapshotPredicates(snapshot, 's', 42);
    expect(fragments.length).toBeGreaterThan(1);
    expect(JSON.stringify(snapshot)).not.toContain('serial-private');
    expect(JSON.stringify(snapshot)).not.toContain('auth-private');
    expect(JSON.stringify(snapshot)).not.toContain('wallet-private');
    const labels = fragments.flatMap((fragment) => {
      expect(fragment.params.length).toBeLessThanOrEqual(60);
      expect(fragment.params.slice(-2)).toEqual([42, 'a'.repeat(64)]);
      const slots = scanSecretSlots(fragment.sql, fragment.params.length);
      if (!slots) throw new Error('Invalid structural labels');
      return slots.flatMap((slot, index) => {
        const value = fragment.params[index];
        if (typeof value === 'string')
          expect(new TextEncoder().encode(value).byteLength).toBeLessThanOrEqual(750_000);
        return [{ label: slot.label, value }];
      });
    });
    expect(labels.some((slot) => slot.label === 'serial' && slot.value === 'serial-private')).toBe(
      true,
    );
    expect(
      labels.some((slot) => slot.label === 'auth-token' && slot.value === 'auth-private'),
    ).toBe(true);
    expect(
      labels.filter((slot) => slot.label === 'history-current-wallet-private-values').length,
    ).toBeGreaterThan(1);
    for (const { value } of labels) {
      if (typeof value !== 'string') continue;
      let json: unknown;
      try {
        json = JSON.parse(value);
      } catch {
        continue;
      }
      expect(JSON.stringify(json)).not.toContain('serial-private');
      expect(JSON.stringify(json)).not.toContain('auth-private');
      expect(JSON.stringify(json)).not.toContain('wallet-private');
    }
  });

  it('fails closed for unknown evidence, invalid aliases, missing keys, and invalid keysets', () => {
    const valid = proof('[]');
    const denied = [{ sql: '0', params: [] }];
    expect(historyProofSnapshotPredicates({ ...valid, projectionCurrent: false }, 's', 42)).toEqual(
      denied,
    );
    expect(historyProofSnapshotPredicates(valid, 's) OR 1=1 --', 42)).toEqual(denied);
    expect(
      historyProofSnapshotPredicates({ ...valid, credentialKeysetCommitment: '' }, 's', 42),
    ).toEqual(denied);
    expect(
      historyProofSnapshotPredicates(
        { ...valid, credentialKeysetCommitment: 'b'.repeat(64) },
        's',
        42,
      ),
    ).toEqual(denied);
    expect(
      historyProofSnapshotPredicates(
        { ...valid, snapshot: { metadata: valid.snapshot.metadata } },
        's',
        42,
      ),
    ).toEqual(denied);
    expect(captureHistoryProofSnapshot({ id: 'incomplete' }, 'a'.repeat(64))).toBeNull();
  });
});
