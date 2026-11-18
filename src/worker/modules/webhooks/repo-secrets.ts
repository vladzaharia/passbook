import type { Grant, GrantedStatement } from '../../platform/authority.ts';
import { gt } from '../../platform/authority-expr.ts';
import type { Envelope } from '../../platform/crypto.ts';
import { all } from '../../platform/db.ts';
import { assertOrgModeGrant } from './repo-endpoints.ts';
import type { FeedFence } from './repo-feed.ts';

function bytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  return Uint8Array.from(value as number[]);
}

export interface SecretRow {
  id: string;
  endpointId: string;
  envelope: Envelope;
  createdAt: number;
  expiresAt: number | null;
}

/** The new current secret. The endpoint must be in the grant's tenant, else nothing is inserted. */
export function insertSecret(
  g: Grant,
  s: { id: string; endpointId: string; envelope: Envelope; now: number },
): GrantedStatement {
  assertOrgModeGrant(g);
  return g.insertSelect(
    'webhook_endpoint_secrets',
    ['id', 'kek_version', 'iv', 'wrapped_dek', 'ciphertext', 'created_at'],
    [
      s.id,
      s.envelope.kekVersion,
      s.envelope.iv,
      s.envelope.wrappedDek,
      s.envelope.ciphertext,
      s.now,
    ],
    {
      from: {
        table: 'webhook_endpoints',
        where: { id: s.endpointId },
        copy: { endpoint_id: 'id' },
      },
      returning: ['id'],
    },
  );
}

/**
 * Rotation as one statement set. It starts by touching the endpoint with `require: 'one'`, so a foreign or
 * deleted endpoint aborts the batch (and its audit row) instead of returning a secret that was never stored.
 * Then the current secret expires after `overlapMs`, any older expiring secret is cut to now (an expiry only
 * moves earlier), and the new current secret is inserted.
 */
export function rotateSecret(
  g: Grant,
  s: { id: string; endpointId: string; envelope: Envelope; now: number; overlapMs: number },
): GrantedStatement[] {
  assertOrgModeGrant(g);
  return [
    g.update('webhook_endpoints', {
      where: { id: s.endpointId },
      set: { updated_at: s.now },
      require: 'one',
    }),
    g.update('webhook_endpoint_secrets', {
      where: { endpoint_id: s.endpointId, expires_at: gt(s.now) },
      set: { expires_at: s.now },
    }),
    g.update('webhook_endpoint_secrets', {
      where: { endpoint_id: s.endpointId, expires_at: null },
      set: { expires_at: s.now + s.overlapMs },
    }),
    insertSecret(g, s),
  ];
}

/** The secrets a delivery signs with: the current one and any still inside its overlap. */
export async function activeSecrets(
  db: D1Database,
  fence: FeedFence,
  endpointId: string,
  now: number,
): Promise<SecretRow[]> {
  const rows = await all<{
    id: string;
    endpoint_id: string;
    kek_version: number;
    iv: unknown;
    wrapped_dek: unknown;
    ciphertext: unknown;
    created_at: number;
    expires_at: number | null;
  }>(
    db,
    `SELECT id, endpoint_id, kek_version, iv, wrapped_dek, ciphertext, created_at, expires_at
     FROM webhook_endpoint_secrets
     WHERE endpoint_id = ? AND org_id = ? AND mode = ? AND (expires_at IS NULL OR expires_at > ?)
     ORDER BY created_at DESC, id`,
    [endpointId, fence.orgId, fence.mode, now],
  );
  return rows.map((r) => ({
    id: r.id,
    endpointId: r.endpoint_id,
    envelope: {
      kekVersion: r.kek_version,
      iv: bytes(r.iv),
      wrappedDek: bytes(r.wrapped_dek),
      ciphertext: bytes(r.ciphertext),
    },
    createdAt: r.created_at,
    expiresAt: r.expires_at,
  }));
}
